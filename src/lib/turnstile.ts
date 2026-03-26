interface TurnstileResponse {
  success: boolean;
  "error-codes": string[];
}

export async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string
): Promise<{ success: boolean; errorCodes: string[] }> {
  const formData = new FormData();
  formData.append("secret", secret);
  formData.append("response", token);
  formData.append("remoteip", ip);

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: formData,
    }
  );

  const data = (await response.json()) as TurnstileResponse;
  return {
    success: data.success,
    errorCodes: data["error-codes"] ?? [],
  };
}
