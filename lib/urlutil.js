'use strict';

// Turn whatever the user typed into the address bar into a URL.
// Returns null for input we refuse to navigate to (unknown schemes, empty).
function normalizeInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^(https?|file|about):/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // other schemes: not handled

  const noSpaces = !/\s/.test(s);
  const looksLikeUrl =
    noSpaces &&
    (/^localhost(:\d+)?([/?#]|$)/i.test(s) ||
      /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(s));
  if (looksLikeUrl) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Registrable domain, good enough without a public-suffix list:
// "www.example.com" -> "example.com", "a.b.co.uk" -> "b.co.uk"
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'nic']);
function baseDomain(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function sameSite(a, b) {
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (!ha || !hb) return false;
  return baseDomain(ha) === baseDomain(hb);
}

function isWebUrl(u) {
  return /^https?:\/\//i.test(u || '');
}

function displayHost(u) {
  const h = hostOf(u);
  return h.replace(/^www\./, '') || u;
}

module.exports = { normalizeInput, hostOf, baseDomain, sameSite, isWebUrl, displayHost };
