# Local Python calculator

Each calculation starts a fresh Pyodide interpreter in a disposable Node worker. It accepts JSON inputs, Python source, selected output names and optional units. Standard-library math, statistics, decimal and fractions are available. Runtime package installation and the JavaScript bridge are not exposed by the allowed import set. No host filesystem is mounted.

The supervisor allows one job at a time, limits source and JSON sizes, bounds output to 64 KiB, and terminates execution after five seconds (startup has its own 30-second bound). Workers receive an empty environment. Python errors, missing outputs, timeouts and a busy worker return typed failures. Each job loses its interpreter state when it ends.

This is a practical local research tool, **not an operating-system security boundary**. Syntax filtering and a worker are not a hostile-code sandbox. The Node heap bound does not fully bound WebAssembly memory. The application is intended for trusted local use. Docker is neither required nor used for development tests, as requested.

The calculator verifies arithmetic on supplied inputs; it does not verify that a selected finance formula is appropriate. Preserve the formula, inputs, units and rounding assumptions when explaining a result.
