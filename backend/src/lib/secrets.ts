import crypto from "crypto";

const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const material = process.env["UPSTOXBOT_SECRET_KEY"]?.trim();
  if (!material) return null;
  return crypto.createHash("sha256").update(material).digest();
}

export function protectSecret(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (value.startsWith(PREFIX)) return value;

  const key = getKey();
  if (!key) {
    throw new Error("UPSTOXBOT_SECRET_KEY is required to protect secrets");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

export function revealSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(PREFIX)) return value;

  const key = getKey();
  if (!key) {
    throw new Error("UPSTOXBOT_SECRET_KEY is required to decrypt stored secrets");
  }

  const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
