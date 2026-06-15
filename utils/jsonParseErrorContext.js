const DEFAULT_CONTEXT_CHARS = 60;

function extractJsonParsePosition(message, body) {
  if (!message) return null;

  const posMatch = message.match(/position\s+(\d+)/i);
  if (posMatch) {
    return parseInt(posMatch[1], 10);
  }

  if (!body || typeof body !== "string") {
    return null;
  }

  const tokenMatch = message.match(/Unexpected token '(.?)'/);
  const snippetMatch = message.match(/\.\.\.([\s\S]+?)\.\.\./);
  if (!snippetMatch) {
    return null;
  }

  let snippet = snippetMatch[1].replace(/\\"/g, '"').replace(/^"+|"+$/g, "");
  let idx = body.indexOf(snippet);
  if (idx === -1 && snippet.length > 10) {
    idx = body.indexOf(snippet.slice(0, 10));
  }
  if (idx === -1) {
    return null;
  }

  const token = tokenMatch && tokenMatch[1];
  if (token) {
    const rel = body.slice(idx).indexOf(token);
    if (rel !== -1) {
      return idx + rel;
    }
  }

  return idx + snippet.length;
}

function buildJsonParseContext(body, position, contextChars = DEFAULT_CONTEXT_CHARS) {
  if (!body || typeof body !== "string" || position == null || position < 0) {
    return null;
  }

  const start = Math.max(0, position - contextChars);
  const end = Math.min(body.length, position + contextChars);

  return {
    position,
    before: body.slice(start, position),
    after: body.slice(position, end),
    excerpt: `${body.slice(start, position)}⟫${body.slice(position, end)}`,
  };
}

function formatJsonParseError(err, contextChars = DEFAULT_CONTEXT_CHARS) {
  const body = typeof err.body === "string" ? err.body : "";
  const detail = err.message || "Request body is not valid JSON";
  const position = extractJsonParsePosition(detail, body);
  const context = buildJsonParseContext(body, position, contextChars);

  return { detail, position, context };
}

module.exports = {
  DEFAULT_CONTEXT_CHARS,
  extractJsonParsePosition,
  buildJsonParseContext,
  formatJsonParseError,
};
