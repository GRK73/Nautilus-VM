# audio-match sidecar

Build the isolated matcher once:

```bash
docker build -t nautilus-audio-match:local tools/audio-match
npm run test:audio-match
```

`Identifier.audioMatch()` invokes this image as a one-shot, network-disabled
container. The active case's artifacts are mounted read-only and derived
landmark/features are cached under that case's artifact directory.

The exact stage uses landmark peak-pair hashes and offset voting. Fingerprint
misses continue to librosa chroma/MFCC subsequence DTW. Scores remain labelled
by method; they are never treated as one shared confidence scale.
