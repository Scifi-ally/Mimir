import { describe, it, expect } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { extractUpstoxErrorMessage } from "./system";

/** Build an AxiosError shaped like the real one thrown by auth.ts. */
function axiosErrorWith(data: unknown, status = 401): AxiosError {
  const err = new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined as never, undefined as never);
  (err as unknown as { response: unknown }).response = {
    status,
    statusText: "",
    data,
    headers: new AxiosHeaders(),
    config: {} as never,
  };
  return err;
}

describe("extractUpstoxErrorMessage", () => {
  it("reads Upstox's plural `errors` array", () => {
    // The real body. The first implementation only matched the singular `error`
    // key, so it returned null and the authorize page showed a generic message.
    const body = {
      status: "error",
      errors: [
        {
          errorCode: "UDAPI100057",
          message: "Invalid Auth code",
          propertyPath: null,
          invalidValue: null,
        },
      ],
    };
    expect(extractUpstoxErrorMessage(axiosErrorWith(body))).toBe("Invalid Auth code");
  });

  it("takes the first message when several errors are returned", () => {
    const body = { errors: [{ message: "first problem" }, { message: "second" }] };
    expect(extractUpstoxErrorMessage(axiosErrorWith(body))).toBe("first problem");
  });

  it("prefers `message` over `errorCode`", () => {
    const body = { errors: [{ errorCode: "UDAPI100050", message: "Invalid token" }] };
    expect(extractUpstoxErrorMessage(axiosErrorWith(body))).toBe("Invalid token");
  });

  it("handles a Cloudflare block envelope (prefers detail over title)", () => {
    // Upstox's edge returns this when the request is blocked before reaching
    // the app. It means "blocked", not "bad credentials", and saying so is
    // materially more useful than a generic error.
    const body = {
      type: "https://developers.cloudflare.com/...",
      title: "Error 1010: Access denied",
      status: 403,
      detail: "The site owner has blocked access based on your browser's signature.",
    };
    const msg = extractUpstoxErrorMessage(axiosErrorWith(body));
    expect(msg).toContain("blocked access");
  });

  it("handles a flat string body", () => {
    expect(extractUpstoxErrorMessage(axiosErrorWith("Something went wrong"))).toBe("Something went wrong");
  });

  it("returns null for an empty body", () => {
    expect(extractUpstoxErrorMessage(axiosErrorWith({}))).toBeNull();
  });

  it("returns null for a non-axios error with no payload", () => {
    expect(extractUpstoxErrorMessage(new Error("boom"))).toBeNull();
  });

  it("does not hang on a self-referential payload", () => {
    const body: Record<string, unknown> = {};
    body.errors = [body];
    expect(extractUpstoxErrorMessage(axiosErrorWith(body))).toBeNull();
  });
});
