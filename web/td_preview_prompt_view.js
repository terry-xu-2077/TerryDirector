/** Read-only screenplay presentation. Tokens retain the exact source text. */
const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));

export function tokenizePreviewPrompt(source) {
  const text = String(source ?? "");
  const pattern = /^[\t ]*镜头\s*\d+\s*[｜|]\s*\[\s*\d+(?:\.\d+)?\s*[–—−-]\s*\d+(?:\.\d+)?\s*s\s*\][\t ]*(?=\r?$)|^[\t ]*\[[^\]\r\n]+\][\t ]*(?=\r?$)|<\s*(Picture|Audio|Video|Prompt)\s+([^<>\r\n]+?)\s*>/gmi;
  const tokens = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) tokens.push({kind:"text",raw:text.slice(offset,match.index)});
    const raw = match[0];
    const kind = match[1] ? "reference" : raw.trim().startsWith("镜头") ? "shot" : "section";
    tokens.push({kind,raw,...(kind === "reference" ? {type:match[1].toLowerCase(),name:match[2].trim()} : {})});
    offset = match.index + raw.length;
  }
  if (offset < text.length) tokens.push({kind:"text",raw:text.slice(offset)});
  return tokens;
}

export function renderPreviewPrompt(source) {
  const labels = {picture:"图片",audio:"音频",video:"视频",prompt:"待生成"};
  return tokenizePreviewPrompt(source).map(token => {
    if (token.kind === "text") return escapeHtml(token.raw);
    const label = token.kind === "reference" ? labels[token.type] + " · " + token.name :
      token.kind === "section" ? token.raw.trim().slice(1,-1) : token.raw.trim();
    return '<span class="tdm-prompt-tag tdm-prompt-'+token.kind+'"'+
      (token.type ? ' data-media-kind="'+token.type+'"' : '')+
      ' title="'+escapeHtml(token.raw)+'">'+escapeHtml(label)+'</span>';
  }).join("");
}
