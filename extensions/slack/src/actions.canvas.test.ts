import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSlackAuth = vi.fn();
const createSlackWebClientMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor/media.js", () => ({
  fetchWithSlackAuth: (...args: Parameters<typeof fetchWithSlackAuth>) =>
    fetchWithSlackAuth(...args),
  resolveSlackMedia: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
  createSlackWriteClient: createSlackWebClientMock,
  getSlackWriteClient: createSlackWebClientMock,
}));

let readSlackCanvas: typeof import("./actions.js").readSlackCanvas;

function createClient() {
  return {
    files: {
      info: vi.fn(async () => ({ file: {} })),
    },
  } as unknown as WebClient & {
    files: {
      info: ReturnType<typeof vi.fn>;
    };
  };
}

describe("readSlackCanvas", () => {
  beforeAll(async () => {
    ({ readSlackCanvas } = await import("./actions.js"));
  });

  beforeEach(() => {
    fetchWithSlackAuth.mockReset();
    createSlackWebClientMock.mockReset();
  });

  it("reads Canvas HTML from Slack private download URL and returns readable text", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        title: "Plan",
        filetype: "quip",
        mimetype: "application/vnd.slack-docs",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/canvas.html",
      },
    });
    createSlackWebClientMock.mockReturnValueOnce(client);
    fetchWithSlackAuth.mockResolvedValueOnce(
      new Response(
        '<div class="quip-canvas-content"><h1>Plan &amp; Next</h1><p>Hello<br>world</p></div>',
      ),
    );

    const result = await readSlackCanvas("F123", { token: "xoxb-test" });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expect(fetchWithSlackAuth).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T1-F123/canvas.html",
      "xoxb-test",
    );
    expect(result).toMatchObject({
      canvasId: "F123",
      title: "Plan",
      filetype: "quip",
      mimetype: "application/vnd.slack-docs",
      text: "Plan & Next\nHello\nworld",
    });
  });

  it("rejects non-Canvas Slack files", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        filetype: "png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    });
    createSlackWebClientMock.mockReturnValueOnce(client);

    await expect(readSlackCanvas("F123", { token: "xoxb-test" })).rejects.toThrow("not a Canvas");
    expect(fetchWithSlackAuth).not.toHaveBeenCalled();
  });
});
