import { catalogPath } from '../authority.mjs';
import { jsonRecordLocator } from '../source.mjs';

export function sourceAt(source, path, needle) {
  if (!source.exists(path)) return null;
  return source.location(path, needle);
}

export function catalogLocation(source, id) {
  if (!source.exists(catalogPath)) return null;
  return jsonRecordLocator(catalogPath, source.read(catalogPath))(id);
}

export function sourceRef(location) {
  return location ? { path: location.path, line: location.line, symbol: location.symbol } : null;
}

export function control(source, { id, platform, path, label, handler, region, role = 'button' }) {
  if (!source.exists(path)) return null;
  const event = sourceAt(source, path, handler);
  const labelAt = label ? sourceAt(source, path, label) : event;
  if (!event || !labelAt) return null;
  return { id, platform, source: sourceRef(event), label, role, handler, region };
}

export function routeMatch(source, path, route, pattern) {
  if (!source.exists(path)) return null;
  const text = source.read(path);
  const match = text.match(pattern);
  if (!match || match[1] !== route) return null;
  return sourceAt(source, path, match[0]);
}

export function transition({ id, platform, from, to, event, screen, control: controlId, condition, location }) {
  if (!location) return null;
  return {
    id, platform, from, to, event,
    ...(screen ? { screen } : {}), ...(controlId ? { control: controlId } : {}),
    ...(condition ? { condition } : {}), source: sourceRef(location), method: 'static',
  };
}

export function gap({ id, platform, reason, location, status = 'unimplemented' }) {
  if (!location) return null;
  return { id, platform, status, reason, source: sourceRef(location) };
}

export const records = (...items) => items.flat(Infinity).filter(Boolean);
