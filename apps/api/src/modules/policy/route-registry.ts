/**
 * Route → action bindings. Populated by `defineResource({ routes })`,
 * consumed by `policyMiddleware` and `/policy/manifest`.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteBinding {
  readonly resourceName: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly action: string;
}

const bindings: RouteBinding[] = [];

export function registerRouteBinding(b: RouteBinding): void {
  bindings.push(b);
}

export function getAllRouteBindings(): readonly RouteBinding[] {
  return [...bindings];
}

export function getRouteBindingsForResource(name: string): readonly RouteBinding[] {
  return bindings.filter(b => b.resourceName === name);
}

export function __resetRouteBindingsForTests(): void {
  bindings.length = 0;
}
