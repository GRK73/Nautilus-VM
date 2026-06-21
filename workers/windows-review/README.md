# Windows Hyper-V review worker

This worker never falls back to host execution. Prepare a disposable Windows
VM with Guest Services and PowerShell Direct, create a clean checkpoint named
`NautilusClean`, then configure `NAUTILUS_WINDOWS_REVIEW_VM`, `_USER`, and
`_PASSWORD`. Networking is disconnected before every run and the checkpoint is
restored both before and after execution.
