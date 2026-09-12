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

    let page = 0;
    let totalPages = 1;
    let allEmployees = [];

    while (page < totalPages && page < 20) {
      const requestUrl =
        `${baseUrl}/api/v1/employees` +
        `?page=${page}&size=100`;

      const employeeResponse = await fetch(requestUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!employeeResponse.ok) {
        return res.status(employeeResponse.status).json({
          connected: false,
          error: "Unable to retrieve employees",
          status: employeeResponse.status,
        });
      }

      const data = await employeeResponse.json();

      const pageEmployees = Array.isArray(data)
        ? data
        : data.content ||
          data.data ||
          data.employees ||
          [];

      allEmployees = allEmployees.concat(pageEmployees);

      if (Array.isArray(data)) {
        totalPages = 1;
      } else if (typeof data.totalPages === "number") {
        totalPages = data.totalPages;
      } else if (typeof data.totalElements === "number") {
        totalPages = Math.ceil(data.totalElements / 100);
      } else {
        totalPages = 1;
      }

      page += 1;
    }

    const shopEmployees = allEmployees.filter((employee) => {
      if (String(employee.shopId || "") === String(shopId)) {
        return true;
      }

      if (!Array.isArray(employee.shops)) {
        return false;
      }

      return employee.shops.some((shop) => {
        const employeeShopId =
          typeof shop === "object"
            ? shop.id ?? shop.shopId
            : shop;

        return String(employeeShopId) === String(shopId);
      });
    });

    const safeEmployees = shopEmployees.map((employee) => ({
      id: employee.id,
      firstName: employee.firstName || "",
      lastName: employee.lastName || "",
      role: employee.employeeRole || null,
      payType: employee.employeePayType || null,
      disabled: Boolean(employee.disabled),
    }));

    return res.status(200).json({
      connected: true,
      shopId: Number(shopId),
      allSandboxEmployeesChecked: allEmployees.length,
      shopEmployeesReturned: safeEmployees.length,
      employees: safeEmployees,
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: "Unable to reach the Tekmetric API",
    });
  }
};