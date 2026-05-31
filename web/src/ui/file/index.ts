/**
 * File UI barrel.
 *
 * App mounts <FileMenu/> in the top toolbar. It is a self-contained controller:
 * the "File" dropdown (New / Open Project… / Save Project / Export As…) plus
 * the per-export dialog (PNG / JPEG / WebP with a quality slider). All project
 * I/O + image export routes through the engine; the UI never touches pixels.
 */
export { FileMenu } from "./FileMenu";
export { ExportDialog } from "./ExportDialog";
