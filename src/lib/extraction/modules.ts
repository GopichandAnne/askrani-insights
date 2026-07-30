import type { VerticalModule } from "./vertical";
import { RestaurantModule } from "./restaurant";
import { GroceryModule } from "./grocery";

/**
 * Vertical module registry. Restaurant and grocery are implemented; expansion
 * verticals (§7.4) slot in here behind the same VerticalModule interface.
 */
const MODULES: Record<string, VerticalModule> = {
  restaurant: new RestaurantModule(),
  grocery: new GroceryModule(),
};

export function moduleFor(vertical: string): VerticalModule {
  return MODULES[vertical] ?? MODULES.restaurant;
}

export function hasModule(vertical: string): boolean {
  return vertical in MODULES;
}
