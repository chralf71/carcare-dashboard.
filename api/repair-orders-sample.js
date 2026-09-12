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
      `&page=0&size=3`;

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

    const samples = repairOrders.map((repairOrder) => ({
      id: repairOrder.id,
      repairOrderNumber: repairOrder.repairOrderNumber,
      status: repairOrder.repairOrderStatus,
      label: repairOrder.repairOrderLabel,
      customLabel: repairOrder.repairOrderCustomLabel,
      serviceWriterId: repairOrder.serviceWriterId,
      technicianId: repairOrder.technicianId,
      laborSales: repairOrder.laborSales,
      partsSales: repairOrder.partsSales,
      subletSales: repairOrder.subletSales,
      discountTotal: repairOrder.discountTotal,
      feeTotal: repairOrder.feeTotal,
      totalSales: repairOrder.totalSales,
      jobCount: Array.isArray(repairOrder.jobs)
        ? repairOrder.jobs.length
        : null,
      createdDate: repairOrder.createdDate,
      completedDate: repairOrder.completedDate,
      postedDate: repairOrder.postedDate,
    }));

    return res.status(200).json({
      connected: true,
      shopId: Number(shopId),
      samples,
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: "Unable to reach the Tekmetric API",
    });
  }
};