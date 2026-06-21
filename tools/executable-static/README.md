# Executable static analyzer

Network-disabled sidecar combining LIEF, YARA, capa, FLOSS, `file`, and
`strings`-class analysis. It also extracts validated embedded FWS/CWS payloads
for the existing `flash_review` pipeline.

```bash
docker build -t nautilus-executable-static:local tools/executable-static
```
