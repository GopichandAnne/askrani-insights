import type { VerticalModule } from "./vertical";
import { RestaurantModule } from "./restaurant";
import { GroceryModule } from "./grocery";
import { SalonModule } from "./salon";

/**
 * Vertical module registry. Restaurant, grocery and salon (beauty / med-spa) are
 * implemented; further expansion verticals (§7.4) slot in here behind the same
 * VerticalModule interface.
 */
const MODULES: Record<string, VerticalModule> = {
  restaurant: new RestaurantModule(),
  grocery: new GroceryModule(),
  salon: new SalonModule(),
};

export function moduleFor(vertical: string): VerticalModule {
  return MODULES[vertical] ?? MODULES.restaurant;
}

export function hasModule(vertical: string): boolean {
  return vertical in MODULES;
}
