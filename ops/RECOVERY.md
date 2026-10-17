# Local operation and recovery

Start the built app with `npm start`, or run the `app` Docker image (see README.md). Runtime data defaults to `app-data/` and is ignored by Git. `STUDY_DATA_DIR` changes its location. Avoid two app processes writing the same data directory: SQLite handles transactions, but in-memory sessions, calculator concurrency and AI cancellation belong to one process.

## Backup

Run `npm run backup -- backup app-data/study.sqlite app-data/backups/2026-10-15.sqlite`. Use a new name each time. This uses SQLite's online snapshot interface, validates database integrity and references, then writes an adjacent SHA-256 manifest. The snapshot includes uploaded Markdown, imported versions of configured-folder Markdown and AI/personal note records. It excludes credentials, session cookies and external source changes not yet imported.

## Restore

1. Restore to a new folder with `npm run backup -- restore app-data/backups/2026-10-15.sqlite app-data/restored/study.sqlite`.
2. Stop the app.
3. Set `STUDY_DATA_DIR=app-data/restored` in `.env`.
4. Start the app, sign in again if a password is configured, and check a saved set, annotation, chat and source revision.
5. Keep the previous data directory until satisfied. Rollback means stopping the app and restoring its prior `STUDY_DATA_DIR`, not overwriting a live database.

External materials are separate from the database snapshot. Compare their files with the restored imported snapshots before editing or reimporting. Configure the same existing material root only after that review. No credentials are copied by this procedure.

## Interrupted local-file save

The editor checks both the imported hash and current disk bytes. It writes a journal, syncs a temporary file, atomically replaces the source, commits reimport, then removes the journal. There is no recovery screen yet: list unresolved journals with `GET /api/material-recovery`, and resolve one with `POST /api/libraries/<libraryId>/material-recovery/<journalId>`. A matching new hash permits reimport; a matching old hash permits discarding the unfinished journal. A third hash means an external edit and requires manual reconciliation. The journal retains both old and new content. Back up the journal before manual repair.

Application locks cannot prevent an unrelated editor from racing the final filesystem rename. Do not edit the same source simultaneously in two programs.

## Authentication and AI recovery

Sessions exist only in the current process and expire after 24 hours. Restart invalidates them. The local account password is loaded from `.env`, never stored in exported study data. No API key is accepted by the subscription provider. If Codex credentials/catalog expire, refresh the login in Codex and retry. Provider failures preserve the study core and label incomplete messages honestly. Runs interrupted by restart retain partial content.

## Verification boundary

Tests run natively and in the Linux Docker test image (Node.js 24, SQLite, Pyodide workers, Chromium). HTTPS proxy deployment and physical-device behavior are not established by those tests.
