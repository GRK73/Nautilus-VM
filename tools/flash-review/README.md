# Flash review sidecar

Build the pinned JPEXS + Ruffle + Playwright image:

```bash
docker build -t nautilus-flash-review:local tools/flash-review
npm run test:flash-review
```

Nautilus invokes the image with no external network, a read-only artifact
mount, dropped Linux capabilities, and bounded CPU, memory, PIDs, and runtime.
Static SWF parsing stays in `@aivm/flash`; `full` mode additionally captures a
JPEXS dump and runs a short Ruffle input/render smoke test.
