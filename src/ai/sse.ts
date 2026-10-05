// Minimal server-sent-events decoder over a fetch Response body.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (dataLines.length > 0) {
            yield { event, data: dataLines.join("\n") };
          }
          event = undefined;
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
  } finally {
    reader.releaseLock();
  }
}
