#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import zlib
from pathlib import Path
from typing import Any

import lief
import yara

RULES = r'''
rule Suspicious_Process_Injection {
  strings: $a = "WriteProcessMemory" ascii wide $b = "CreateRemoteThread" ascii wide $c = "VirtualAllocEx" ascii wide
  condition: 2 of them
}
rule Suspicious_Downloader {
  strings: $a = "URLDownloadToFile" ascii wide $b = "WinHttpOpen" ascii wide $c = "powershell" nocase ascii wide
  condition: 2 of them
}
rule Packer_Markers {
  strings: $a = "UPX0" ascii $b = "UPX1" ascii $c = "VMProtect" ascii $d = "Themida" ascii
  condition: any of them
}
'''


def command(args: list[str], timeout: int = 45) -> tuple[int, str, str]:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
        return result.returncode, result.stdout, result.stderr
    except Exception as exc:
        return -1, "", str(exc)


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = [0] * 256
    for value in data:
        counts[value] += 1
    return -sum((count / len(data)) * math.log2(count / len(data)) for count in counts if count)


def lief_report(path: str) -> dict[str, Any]:
    binary = lief.parse(path)
    if binary is None:
        return {}
    sections = []
    for section in getattr(binary, "sections", []):
        content = bytes(section.content)
        sections.append({"name": section.name, "size": int(section.size), "entropy": entropy(content)})
    imports: list[str] = []
    libraries: list[str] = []
    for imported in getattr(binary, "imports", []):
        libraries.append(str(getattr(imported, "name", "")))
        imports.extend(str(getattr(entry, "name", "") or getattr(entry, "ordinal", "")) for entry in getattr(imported, "entries", []))
    exports = [str(value) for value in getattr(binary, "exported_functions", [])]
    signatures = [str(getattr(sig, "version", "authenticode")) for sig in getattr(binary, "signatures", [])]
    return {
        "sections": sections[:500], "imports": imports[:5000], "exports": exports[:5000],
        "libraries": [value for value in libraries if value][:1000], "signatures": signatures[:100],
    }


def parse_capa(path: str, errors: list[str]) -> list[str]:
    status, stdout, stderr = command(["capa", "-r", "/opt/capa-rules", "-j", path], 60)
    if status not in (0, 1):
        errors.append(f"capa: {(stderr or stdout).strip()[-300:]}")
        return []
    try:
        payload = json.loads(stdout)
        rules = payload.get("rules", {})
        return list(rules.keys())[:500] if isinstance(rules, dict) else []
    except Exception as exc:
        errors.append(f"capa JSON: {exc}")
        return []


def parse_floss(path: str, errors: list[str]) -> list[str]:
    status, stdout, stderr = command(["floss", "--json", path], 60)
    if status != 0:
        errors.append(f"floss: {(stderr or stdout).strip()[-300:]}")
        return []
    try:
        payload = json.loads(stdout)
        found: list[str] = []
        strings = payload.get("strings", {})
        for group in strings.values() if isinstance(strings, dict) else []:
            if isinstance(group, list):
                for value in group:
                    text = value.get("string") if isinstance(value, dict) else value
                    if isinstance(text, str) and len(text) >= 5:
                        found.append(text)
        return list(dict.fromkeys(found))[:1000]
    except Exception as exc:
        errors.append(f"floss JSON: {exc}")
        return []


def extract_swfs(data: bytes, prefix: str, output: Path) -> list[str]:
    files: list[str] = []
    for match in list(re.finditer(b"(?:FWS|CWS|ZWS)", data))[:50]:
        offset = match.start()
        if offset + 8 > len(data):
            continue
        signature = data[offset:offset + 3]
        declared = int.from_bytes(data[offset + 4:offset + 8], "little")
        if declared < 8 or declared > 256 * 1024 * 1024:
            continue
        blob: bytes | None = None
        if signature == b"FWS" and offset + declared <= len(data):
            blob = data[offset:offset + declared]
        elif signature == b"CWS":
            try:
                inflater = zlib.decompressobj()
                inflater.decompress(data[offset + 8:], declared - 8)
                consumed = len(data[offset + 8:]) - len(inflater.unused_data)
                if consumed > 0:
                    blob = data[offset:offset + 8 + consumed]
            except zlib.error:
                pass
        if blob:
            name = f"{prefix}-embedded-{len(files):03d}.swf"
            (output / name).write_bytes(blob)
            files.append(name)
    return files


def analyze(item: dict[str, str], index: int, output: Path) -> dict[str, Any]:
    path = item["path"]
    data = Path(path).read_bytes()
    errors: list[str] = []
    status, file_type, file_error = command(["file", "-b", path], 10)
    if status != 0:
        errors.append(f"file: {file_error.strip()}")
    scanner: dict[str, Any] = {"fileType": file_type.strip(), "errors": errors}
    try:
        scanner.update(lief_report(path))
    except Exception as exc:
        errors.append(f"LIEF: {exc}")
    try:
        scanner["yaraMatches"] = [match.rule for match in yara.compile(source=RULES).match(data=data, timeout=10)]
    except Exception as exc:
        errors.append(f"YARA: {exc}")
        scanner["yaraMatches"] = []
    pe_offset = int.from_bytes(data[0x3c:0x40], "little") if len(data) >= 0x40 and data.startswith(b"MZ") else -1
    is_pe = 0 <= pe_offset <= len(data) - 4 and data[pe_offset:pe_offset + 4] == b"PE\0\0"
    is_elf = data.startswith(b"\x7fELF")
    scanner["capaRules"] = parse_capa(path, errors) if is_pe or is_elf else []
    scanner["flossStrings"] = parse_floss(path, errors) if is_pe else []
    prefix = f"exec-{index:03d}"
    extracted = extract_swfs(data, prefix, output)
    report = {
        "artifactId": item["artifactId"], "sha256": hashlib.sha256(data).hexdigest(),
        "scanner": scanner, "extractedSwfs": extracted,
    }
    report_file = f"{prefix}-report.json"
    (output / report_file).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"artifactId": item["artifactId"], "scanner": scanner, "reportFile": report_file, "extractedSwfs": extracted}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        items = []
        for index, item in enumerate(manifest["items"]):
            try:
                items.append(analyze(item, index, output))
            except Exception as exc:
                items.append({"artifactId": item.get("artifactId", ""), "error": str(exc)})
        print(json.dumps({"items": items}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(f"executable analysis failed: {exc}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
