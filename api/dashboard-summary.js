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
    const accessToken = tokenData.access_token;

    async function getStatusCount(statusId) {
      const requestUrl =
        `${baseUrl}/api/v1/repair-orders` +
        `?shop=${encodeURIComponent(shopId)}` +
        `&repairOrderStatusId=${statusId}` +
        `&page=0&size=1`;

      const response = await fetch(requestUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Status ${statusId} request failed with ${response.status}`
        );
      }

      const data = await response.json();

      return data.totalElements ??
        data.total ??
        data.content?.length ??
        0;
    }

    const [
      estimates,
      workInProgress,
      completed,
      posted,
    ] = await Promise.all([
      getStatusCount(1),
      getStatusCount(2),
      getStatusCount(3),
      getStatusCount(5),
    ]);

    return res.status(200).json({
      connected: true,
      shopId: Number(shopId),
      repairOrders: {
        estimates,
        workInProgress,
        completed,
        posted,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: "Unable to build dashboard summary",
      details: error.message,
    });
  }
};