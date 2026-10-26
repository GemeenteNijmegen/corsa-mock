/**
 * Minimal XML helpers for the StUF messages the laravel-zaakdms client sends.
 *
 * Elements are matched on local name, so the namespace prefix does not matter. This is
 * not a general XML parser: it relies on the client never nesting an element inside an
 * element with the same local name, which holds for all templates in that package.
 */

export interface Element {
  attributes: string;
  inner: string;
}

export function element(xml: string, localName: string): Element | undefined {
  const name = escapeRegExp(localName);
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${name}((?:\\s[^>]*?)?)(?<!/)>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`,
  ).exec(xml);
  return match ? { attributes: match[1] ?? '', inner: match[2] ?? '' } : undefined;
}

/**
 * Inner XML of the first element with this local name, or '' when it is missing.
 */
export function section(xml: string, localName: string): string {
  return element(xml, localName)?.inner ?? '';
}

/**
 * Decoded, trimmed text of the first element with this local name.
 */
export function text(xml: string, localName: string): string | undefined {
  const found = element(xml, localName);
  return found ? decode(found.inner).trim() : undefined;
}

export function attribute(attributes: string, localName: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${escapeRegExp(localName)}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match?.[1] === undefined ? undefined : decode(match[1]);
}

/**
 * Replaces the content of every element with this local name, keeping its tags.
 */
export function replaceContent(xml: string, localName: string, replacement: string): string {
  const name = escapeRegExp(localName);
  return xml.replace(
    new RegExp(`(<(?:[\\w.-]+:)?${name}(?:\\s[^>]*?)?(?<!/)>)[\\s\\S]*?(</(?:[\\w.-]+:)?${name}\\s*>)`, 'g'),
    (_match, open: string, close: string) => open + replacement + close,
  );
}

export function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_match, entity: string) => {
      switch (entity.toLowerCase()) {
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'amp': return '&';
      }
      return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10));
    });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
