#!/usr/bin/env python3
"""Batch audio matcher: landmark fingerprints first, subsequence DTW second."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from scipy.ndimage import maximum_filter

FP_SR = 11025
FP_HOP = 512
FEATURE_SR = 22050
FEATURE_HOP = 1024


def load_audio(path: str, sr: int) -> np.ndarray:
    audio, _ = librosa.load(path, sr=sr, mono=True)
    if audio.size < sr // 2:
        raise ValueError(f"audio is too short ({audio.size / sr:.2f}s): {path}")
    return audio


def cache_path(cache_dir: str, artifact_id: str, kind: str) -> Path:
    digest = artifact_id.split(":", 1)[-1]
    path = Path(cache_dir) / kind / f"{digest}.npz"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def landmark_fingerprint(path: str, artifact_id: str, cache_dir: str) -> tuple[np.ndarray, np.ndarray, float]:
    cached = cache_path(cache_dir, artifact_id, "landmarks-v1")
    if cached.exists():
        data = np.load(cached)
        return data["hashes"], data["times"], float(data["duration"])

    y = load_audio(path, FP_SR)
    spectrum = np.abs(librosa.stft(y, n_fft=2048, hop_length=FP_HOP))
    db = librosa.amplitude_to_db(spectrum, ref=np.max)
    local_max = db == maximum_filter(db, size=(15, 11), mode="constant")
    threshold = max(-55.0, float(np.percentile(db, 88)))
    freqs, times = np.where(local_max & (db >= threshold))
    strengths = db[freqs, times]

    # Bound peak density so long candidates remain tractable and deterministic.
    order = np.lexsort((-strengths, times))
    peaks: list[tuple[int, int]] = []
    per_frame: Counter[int] = Counter()
    for idx in order:
        t = int(times[idx])
        if per_frame[t] >= 5:
            continue
        peaks.append((t, int(freqs[idx])))
        per_frame[t] += 1
    peaks.sort()

    hashes: list[int] = []
    anchors: list[int] = []
    for i, (t1, f1) in enumerate(peaks):
        paired = 0
        for t2, f2 in peaks[i + 1 :]:
            dt = t2 - t1
            if dt > 200:
                break
            if dt < 2:
                continue
            raw = f"{f1}:{f2}:{dt}".encode("ascii")
            hashes.append(int.from_bytes(hashlib.blake2b(raw, digest_size=8).digest(), "big"))
            anchors.append(t1)
            paired += 1
            if paired >= 12:
                break

    hash_array = np.asarray(hashes, dtype=np.uint64)
    time_array = np.asarray(anchors, dtype=np.int32)
    duration = len(y) / FP_SR
    np.savez_compressed(cached, hashes=hash_array, times=time_array, duration=np.asarray(duration))
    return hash_array, time_array, duration


def fingerprint_match(
    ref: tuple[np.ndarray, np.ndarray, float], candidate: tuple[np.ndarray, np.ndarray, float]
) -> dict[str, Any] | None:
    ref_hashes, ref_times, ref_duration = ref
    cand_hashes, cand_times, _ = candidate
    if ref_hashes.size == 0 or cand_hashes.size == 0:
        return None
    index: dict[int, list[int]] = defaultdict(list)
    for value, timestamp in zip(cand_hashes.tolist(), cand_times.tolist()):
        index[value].append(timestamp)
    votes: Counter[int] = Counter()
    matched_hashes = 0
    for value, timestamp in zip(ref_hashes.tolist(), ref_times.tolist()):
        matches = index.get(value, [])
        if matches:
            matched_hashes += 1
        for candidate_time in matches[:30]:
            votes[candidate_time - timestamp] += 1
    if not votes:
        return None
    offset_frames, aligned = votes.most_common(1)[0]
    confidence = aligned / max(1, len(ref_hashes))
    # Require both an absolute alignment count and a corpus-normalized score.
    if aligned < 8 or confidence < 0.025:
        return None
    return {
        "score": min(1.0, confidence * 5.0),
        "offsetSec": round(offset_frames * FP_HOP / FP_SR, 3),
        "durationSec": round(ref_duration, 3),
        "diagnostics": {
            "alignedHashes": aligned,
            "referenceHashes": int(len(ref_hashes)),
            "sharedReferenceHashes": matched_hashes,
        },
    }


def feature_sequence(path: str, artifact_id: str, cache_dir: str) -> tuple[np.ndarray, np.ndarray, float]:
    cached = cache_path(cache_dir, artifact_id, "features-v1")
    if cached.exists():
        data = np.load(cached)
        return data["chroma"], data["mfcc"], float(data["duration"])
    y = load_audio(path, FEATURE_SR)
    harmonic = librosa.effects.harmonic(y)
    chroma = librosa.feature.chroma_cens(y=harmonic, sr=FEATURE_SR, hop_length=FEATURE_HOP)
    mfcc = librosa.feature.mfcc(y=y, sr=FEATURE_SR, n_mfcc=13, hop_length=FEATURE_HOP)[1:]
    mfcc = librosa.util.normalize(mfcc, axis=1)
    duration = len(y) / FEATURE_SR
    np.savez_compressed(cached, chroma=chroma, mfcc=mfcc, duration=np.asarray(duration))
    return chroma, mfcc, duration


def subsequence_cost(reference: np.ndarray, candidate: np.ndarray, metric: str) -> tuple[float, int]:
    if reference.shape[1] > candidate.shape[1]:
        return float("inf"), 0
    distance, path = librosa.sequence.dtw(X=reference, Y=candidate, metric=metric, subseq=True, backtrack=True)
    end = int(np.argmin(distance[-1]))
    # Re-run backtracking at the best subsequence endpoint; librosa's default
    # endpoint is the final candidate frame, which is wrong for embedded clips.
    _, best_path = librosa.sequence.dtw(X=reference, Y=candidate[:, : end + 1], metric=metric, subseq=True, backtrack=True)
    normalized = float(distance[-1, end]) / max(1, len(best_path))
    start = int(best_path[-1, 1]) if len(best_path) else max(0, end - reference.shape[1])
    return normalized, start


def feature_match(
    ref: tuple[np.ndarray, np.ndarray, float], candidate: tuple[np.ndarray, np.ndarray, float]
) -> dict[str, Any]:
    ref_chroma, ref_mfcc, ref_duration = ref
    cand_chroma, cand_mfcc, _ = candidate
    chroma_cost, start = subsequence_cost(ref_chroma, cand_chroma, "cosine")
    mfcc_cost, _ = subsequence_cost(ref_mfcc, cand_mfcc, "euclidean")
    chroma_score = math.exp(-2.5 * max(0.0, chroma_cost)) if math.isfinite(chroma_cost) else 0.0
    mfcc_score = math.exp(-0.45 * max(0.0, mfcc_cost)) if math.isfinite(mfcc_cost) else 0.0
    score = min(1.0, 0.7 * chroma_score + 0.3 * mfcc_score)
    return {
        "score": score,
        "offsetSec": round(start * FEATURE_HOP / FEATURE_SR, 3),
        "durationSec": round(ref_duration, 3),
        "diagnostics": {
            "chromaScore": round(chroma_score, 6),
            "mfccScore": round(mfcc_score, 6),
            "chromaCost": round(chroma_cost, 6) if math.isfinite(chroma_cost) else None,
            "mfccCost": round(mfcc_cost, 6) if math.isfinite(mfcc_cost) else None,
        },
    }


def run(manifest: dict[str, Any]) -> dict[str, Any]:
    reference = manifest["reference"]
    candidates = manifest["candidates"]
    mode = manifest.get("mode", "auto")
    top_k = max(1, int(manifest.get("topK", 10)))
    cache_dir = manifest.get("cacheDir", "/cache")
    if mode not in {"auto", "fingerprint", "features"}:
        raise ValueError(f"invalid mode: {mode}")

    hits: list[dict[str, Any]] = []
    misses: list[dict[str, str]] = list(candidates)
    if mode in {"auto", "fingerprint"}:
        ref_fp = landmark_fingerprint(reference["path"], reference["id"], cache_dir)
        misses = []
        for candidate in candidates:
            candidate_fp = landmark_fingerprint(candidate["path"], candidate["id"], cache_dir)
            match = fingerprint_match(ref_fp, candidate_fp)
            if match:
                hits.append(
                    {
                        "candidateId": candidate["id"],
                        "method": "fingerprint",
                        **match,
                        "summary": f"landmark fingerprint match at {match['offsetSec']:.2f}s ({match['diagnostics']['alignedHashes']} aligned hashes)",
                    }
                )
            else:
                misses.append(candidate)

    if mode in {"auto", "features"}:
        fuzzy_candidates = candidates if mode == "features" else misses
        if fuzzy_candidates:
            ref_features = feature_sequence(reference["path"], reference["id"], cache_dir)
            for candidate in fuzzy_candidates:
                candidate_features = feature_sequence(candidate["path"], candidate["id"], cache_dir)
                match = feature_match(ref_features, candidate_features)
                hits.append(
                    {
                        "candidateId": candidate["id"],
                        "method": "features",
                        **match,
                        "summary": f"fuzzy subsequence similarity {match['score'] * 100:.1f}% at ~{match['offsetSec']:.2f}s",
                    }
                )

    hits.sort(key=lambda item: (item["method"] == "fingerprint", item["score"]), reverse=True)
    hits = hits[:top_k]
    exact = sum(1 for hit in hits if hit["method"] == "fingerprint")
    return {
        "referenceId": reference["id"],
        "mode": mode,
        "compared": len(candidates),
        "hits": hits,
        "summary": f"compared {len(candidates)} candidate(s): {exact} fingerprint hit(s), {len(hits) - exact} fuzzy result(s)",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    try:
        with open(args.manifest, "r", encoding="utf-8") as handle:
            result = run(json.load(handle))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(f"audio_match failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
