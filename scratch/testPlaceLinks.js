import { renderAccountSignature } from '../src/mailer.js';
// Wait, I just need to copy the render function.

const LINK_MARKER = /\{\{\s*link\s*(?::\s*([^}]*?)\s*)?\}\}/gi;

function placeLinks(escapedParagraph, url) {
  LINK_MARKER.lastIndex = 0;
  let sawMarker = false;
  const out = escapedParagraph.replace(LINK_MARKER, (whole, label) => {
    sawMarker = true;
    const text = String(label ?? '').replace(/\s+/g, ' ').trim() || 'here';
    return url ? anchor(text, escapeHtml(url)) : text;
  });
  if (sawMarker || !url) return out;
  return linkWithoutMarker(out, url);
}

function linkWithoutMarker(escaped, url) {
  const hereRe = /\bhere\b/gi;
  const last = [...escaped.matchAll(hereRe)].pop();
  if (last) {
    return escaped.slice(0, last.index) + anchor('here', escapeHtml(url))
      + escaped.slice(last.index + last[0].length);
  }
  return `${escaped} ${anchor(escapeHtml(url), escapeHtml(url))}`;
}

const ANCHOR_STYLE = 'color:#1155cc;text-decoration:underline';
function anchor(escapedLabel, escapedUrl) {
  return `<a href="${escapedUrl}" style="${ANCHOR_STYLE}">${escapedLabel}</a>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const msg = "We reviewed the latest ADA accessibility audit and implemented custom fixes for the related issues identified. The full audit findings and remediation details are {{link:available}} here.";
const url = "https://docs.google.com/document/d/1vNak3uzHcUO9GBb4mME0vkxuqZJXwyeCBfJf8rP2fpc/edit?usp=sharing";

console.log(placeLinks(escapeHtml(msg), escapeHtml(url)));
