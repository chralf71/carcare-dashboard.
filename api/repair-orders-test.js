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
  const shopId = process.env.TEKMETRIC_SHOP_ID;

  if (!clientId || !clientSecret || !baseUrl || !shopId) {
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

    const requestUrl =
      `${baseUrl}/api/v1/repair-orders` +
      `?shop=${encodeURIComponent(shopId)}` +
      `&page=0&size=10`;

    const repairOrderResponse = await fetch(requestUrl, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/json",
      },
    });

    if (!repairOrderResponse.ok) {
      return res.status(repairOrderResponse.status).json({
        connected: false,
        error: "Unable to retrieve repair orders",
        status: repairOrderResponse.status,
      });
    }

    const data = await repairOrderResponse.json();

    const repairOrders = Array.isArray(data)
      ? data
      : data.content ||
        data.data ||
        data.repairOrders ||
        [];

    return res.status(200).json({
      connected: true,
      shopId: Number(shopId),
      repairOrdersReturned: repairOrders.length,
      totalRepairOrders:
        data.totalElements ?? data.total ?? repairOrders.length,
      availableFields:
        repairOrders.length > 0
          ? Object.keys(repairOrders[0])
          : [],
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: "Unable to reach the Tekmetric API",
    });
  }
};