/**
 * Filters UI barrel.
 *
 * App mounts <FiltersMenu/> (typically in the top toolbar). It is a
 * self-contained controller: the Filter dropdown trigger + the per-filter
 * dialog with live preview. Disabled unless the active layer is a raster layer.
 */
export { FiltersMenu } from "./FilterMenu";
export { FilterDialog } from "./FilterDialog";
