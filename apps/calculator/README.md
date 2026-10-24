# Local Python calculator

Each calculation starts a fresh Pyodide interpreter in a disposable Node process. It accepts JSON inputs, Python source, selected output names and optional units. Standard-library math, statistics, decimal and fractions are available. Runtime package installation and the JavaScript bridge are not exposed by the allowed import set. No host filesystem is mounted.

The supervisor allows one job at a time, limits source and JSON sizes, bounds output to 64 KiB, and terminates execution after five seconds (startup has its own 30-second bound). Workers receive an empty environment. Python errors, missing outputs, timeouts and a busy worker return typed failures. Each job loses its interpreter state when it ends.

The Python syntax filter is a first fence only: Python can always reach the JavaScript host through introspection. The boundary is the process. It runs under Node's permission model (`--permission`), may read only its own script and the Pyodide package, cannot write files, start processes or threads, or load native add-ons, and gets an empty environment, so escaped code cannot read the database, API keys, sign-in files or passwords. Network access is not restricted, and the Node heap bound does not cover WebAssembly memory. In the desktop app the process is Electron run as Node (`ELECTRON_RUN_AS_NODE`).

The calculator verifies arithmetic on supplied inputs; it does not verify that a selected finance formula is appropriate. Preserve the formula, inputs, units and rounding assumptions when explaining a result.
