interface TurnstileResponse {
  success: boolean;
  "error-codes": string[];
}

export async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string
): Promise<{ success: boolean; errorCodes: string[] }> {
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: ip,
      }),
    }
  );

  const data = (await response.json()) as TurnstileResponse;
  return {
    success: data.success,
    errorCodes: data["error-codes"] ?? [],
  };
}
