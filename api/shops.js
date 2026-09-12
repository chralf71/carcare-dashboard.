module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const clientId = process.env.TEKMETRIC_CLIENT_ID;
  const clientSecret = process.env.TEKMETRIC_CLIENT_SECRET;
  const baseUrl = process.env.TEKMETRIC_BASE_URL;

  if (!clientId || !clientSecret || !baseUrl) {
    return res.status(500).json({
      connected: false,
      error: "Missing Tekmetric environment variables",
    });
  }

  try {
    const credentials = Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

    const tokenResponse = await fetch(
      `${baseUrl}/api/v1/oauth/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      }
    );

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        connected: false,
        error: "Tekmetric authentication failed",
      });
    }

    const tokenData = await tokenResponse.json();

    const shopsResponse = await fetch(
      `${baseUrl}/api/v1/shops`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json",
        },
      }
    );

    if (!shopsResponse.ok) {
      return res.status(shopsResponse.status).json({
        connected: false,
        error: "Unable to retrieve Tekmetric shops",
      });
    }

    const shopData = await shopsResponse.json();

    const shops = Array.isArray(shopData)
      ? shopData
      : shopData.content ||
        shopData.data ||
        shopData.shops ||
        [];

    const safeShops = shops.map((shop) => ({
      id: shop.id,
      name: shop.name,
      nickname: shop.nickname || null,
    }));

    return res.status(200).json({
      connected: true,
      shopCount: safeShops.length,
      shops: safeShops,
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: "Unable to reach the Tekmetric API",
    });
  }
};
