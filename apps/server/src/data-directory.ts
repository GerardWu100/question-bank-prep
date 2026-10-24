import { accessSync, constants, mkdirSync } from "node:fs";

/**
 * Make sure the data folder exists and this process can write to it, before the database
 * opens there. Without this, a folder the process cannot write (Docker creates a missing
 * bind-mount folder as root, while the app runs as an ordinary user) fails later with a
 * bare SQLite error that names neither the folder nor the fix.
 *
 * Parameters
 * ----------
 * directory : string
 *     Absolute path of the data folder (`STUDY_DATA_DIR`, resolved).
 *
 * Raises
 * ------
 * Error
 *     When the folder cannot be created or is not writable; the message names the folder,
 *     the process's user and group IDs, and how to fix the folder's owner.
 */
export function ensureWritableDataDirectory(directory: string) {
  try {
    mkdirSync(directory, { recursive: true });
    // Creating the database and its WAL files needs write and search permission on the folder.
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    const user = process.getuid ? ` by user ${process.getuid()}:${process.getgid?.()}` : "";
    throw new Error(
      `The data folder ${directory} is not writable${user} (${reason}). ` +
        "Make it writable by the user that runs the app. With Docker, create the host folder " +
        "as yourself before the first start (mkdir -p <host folder>), give an existing one to " +
        "yourself (sudo chown -R $(id -u):$(id -g) <host folder>), and run the container as " +
        "that user (HOST_UID and HOST_GID in .env).",
      { cause: error },
    );
  }
}
