const customerIdPattern = /V-\d{7,8}(?!\d)/g;

export function maskCustomerId(value: string): string {
  return value.replace(customerIdPattern, (id) => {
    const digits = id.slice(2);
    const hidden = "X".repeat(digits.length - 4);
    return `V-${hidden}${digits.slice(-4)}`;
  });
}

export function maskText(value: string, names: readonly string[]): string {
  let masked = value;
  const ordered = uniqueNames(names);
  for (const name of ordered) {
    masked = masked.split(name).join("[name]");
  }
  return maskCustomerId(masked);
}

export function maskBundle<T>(value: T): T {
  const names = collectCustomerNames(value);
  return maskValue(value, names) as T;
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

function collectCustomerNames(value: unknown): string[] {
  const names: string[] = [];
  walk(value, names);
  return names;
}

function walk(value: unknown, names: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, names);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "customer_name" && typeof child === "string") {
      names.push(child);
    }
    walk(child, names);
  }
}

function maskValue(value: unknown, names: readonly string[]): unknown {
  if (typeof value === "string") return maskText(value, names);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, names));
  if (value === null || typeof value !== "object") return value;

  const masked: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    masked[key] =
      key === "customer_name" ? "[name]" : maskValue(child, names);
  }
  return masked;
}
