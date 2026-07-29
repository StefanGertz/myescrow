function wellFormed(value: string) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0xfffd;
    return codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
  }).join("");
}

export function attachmentContentDisposition(fileName: string) {
  const normalized = wellFormed(fileName).replaceAll("\0", "").trim() || "evidence-file";
  const fallbackName =
    normalized.replace(/[^\x20-\x7e]|[\r\n"\\]/g, "_").trim()
    || "evidence-file";
  const encodedName = encodeURIComponent(normalized).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}
