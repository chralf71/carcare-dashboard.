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
      `${baseUrl}/api/v1/employees` +
      `?shop=${encodeURIComponent(shopId)}` +
      `&page=0&size=100`;

    const employeeResponse = await fetch(requestUrl, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
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

    const employees = Array.isArray(data)
      ? data
      : data.content ||
        data.data ||
        data.employees ||
        [];

    const safeEmployees = employees.map((employee) => ({
      id: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      name: employee.name,
      type: employee.type,
      active: employee.active,
    }));

    return res.status(200).json({
      connected: true,
      shopId: Number(shopId),
      employeesReturned: employees.length,
      totalEmployees:
        data.totalElements ?? data.total ?? employees.length,
      availableFields:
        employees.length > 0
          ? Object.keys(employees[0])
          : [],
      employees: safeEmployees,
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: "Unable to reach the Tekmetric API",
    });
  }
};