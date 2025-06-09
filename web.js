const express = require("express");
const axios = require("axios");
const moment = require("moment");
const path = require("path");
const cookieParser = require("cookie-parser");

const app = express();
const port = process.env.PORT || 3000;

// Custom logging middleware
app.use((req, res, next) => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] ${req.method} ${req.url}`);
	next();
});

// Middleware
app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());

// Octopus Energy API configuration
const octopusConfig = {
	baseURL: "https://api.octopus.energy/v1",
};

// Helper function to format timestamp
const formatTimestamp = () => {
	return moment().utc().format("YYYY-MM-DD HH:mm:ss UTC");
};

// Helper function to format usage data
const formatUsageData = (usage, cost) => {
	return {
		usage: usage.toFixed(2),
		cost: cost.toFixed(2),
	};
};

// Get Kraken token for GraphQL API
async function getKrakenToken(apiKey) {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 🔑 Obtaining Kraken token...`);
	try {
		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `mutation {
                    obtainKrakenToken(input: {APIKey:"${apiKey}"}) {
                        token
                        refreshToken
                        refreshExpiresIn
                    }
                }`,
			},
			{
				headers: {
					"Content-Type": "application/json",
				},
			}
		);
		console.log(`[${timestamp}] ✅ Kraken token obtained successfully`);
		return response.data.data.obtainKrakenToken.token;
	} catch (error) {
		console.error(
			`[${timestamp}] ❌ Error obtaining Kraken token:`,
			error.message
		);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
		}
		throw error;
	}
}

// Get meter GUID
async function getMeterGuid(token, accountNumber) {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(
		`[${timestamp}] 🔍 Looking up meter GUID for account ${accountNumber}...`
	);
	try {
		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `query {
                    account(accountNumber: "${accountNumber}") {
                        electricityAgreements(active: true) {
                            meterPoint {
                                meters(includeInactive: false) {
                                    smartDevices {
                                        deviceId
                                    }
                                }
                            }
                        }
                    }
                }`,
			},
			{
				headers: {
					"Content-Type": "application/json",
					Authorization: `JWT ${token}`,
				},
			}
		);

		const agreements = response.data.data.account.electricityAgreements;
		if (!agreements || agreements.length === 0) {
			throw new Error("No active electricity agreements found");
		}

		const meters = agreements[0].meterPoint.meters;
		if (!meters || meters.length === 0) {
			throw new Error("No active meters found");
		}

		const smartDevices = meters[0].smartDevices;
		if (!smartDevices || smartDevices.length === 0) {
			throw new Error("No smart devices found");
		}

		console.log(
			`[${timestamp}] ✅ Meter GUID found successfully: ${smartDevices[0].deviceId}`
		);
		return smartDevices[0].deviceId;
	} catch (error) {
		console.error(`[${timestamp}] ❌ Error getting meter GUID:`, error.message);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
		}
		throw error;
	}
}

// Get current live usage
async function getLiveUsage(apiKey, accountNumber) {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 📊 Fetching live usage data...`);
	try {
		const token = await getKrakenToken(apiKey);
		const meterGuid = await getMeterGuid(token, accountNumber);

		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `{
                    smartMeterTelemetry(deviceId: "${meterGuid}") {
                        readAt
                        demand
                        consumption
                    }
                }`,
			},
			{
				headers: {
					"Content-Type": "application/json",
					Authorization: `JWT ${token}`,
				},
			}
		);

		if (
			!response.data.data.smartMeterTelemetry ||
			response.data.data.smartMeterTelemetry.length === 0
		) {
			throw new Error("No telemetry data available");
		}

		const telemetry = response.data.data.smartMeterTelemetry[0];
		const usage = telemetry.demand === null ? 0 : Number(telemetry.demand);
		console.log(`[${timestamp}] ✅ Live usage data received: ${usage}W`);
		return usage;
	} catch (error) {
		console.error(
			`[${timestamp}] ❌ Error fetching live usage:`,
			error.message
		);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
		}
		return 0;
	}
}

// Get tariff information
async function getTariffInfo(apiKey, accountNumber, mpan) {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 💰 Fetching tariff information...`);
	try {
		// First get the account info to find the current tariff code
		const accountRes = await axios.get(
			`${octopusConfig.baseURL}/accounts/${accountNumber}/`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(apiKey + ":").toString(
						"base64"
					)}`,
				},
			}
		);

		if (
			!accountRes.data.properties ||
			accountRes.data.properties.length === 0
		) {
			throw new Error("No properties found for account");
		}

		const properties = accountRes.data.properties;
		const propertyWithMpan = properties.find((p) =>
			p.electricity_meter_points.some((e) => e.mpan === mpan)
		);

		if (!propertyWithMpan) {
			throw new Error(`MPAN ${mpan} not found in any property`);
		}

		const electricityPoints = propertyWithMpan.electricity_meter_points;
		const mpanPoint = electricityPoints.find((e) => e.mpan === mpan);

		if (
			!mpanPoint ||
			!mpanPoint.agreements ||
			mpanPoint.agreements.length === 0
		) {
			throw new Error("No active agreements found for MPAN");
		}

		const currentAgreement = mpanPoint.agreements.reduce((latest, current) => {
			if (!latest || new Date(current.valid_to) > new Date(latest.valid_to)) {
				return current;
			}
			return latest;
		}, null);

		if (!currentAgreement) {
			throw new Error("No valid agreement found");
		}

		const tariffCode = currentAgreement.tariff_code;
		console.log(`[${timestamp}] 📝 Found tariff code: ${tariffCode}`);

		// Parse product code and region letter from tariff code
		// Format: E-1R-<PRODUCT>-<REGION>
		const tariffParts = tariffCode.split("-");
		if (tariffParts.length < 4) {
			throw new Error(`Invalid tariff code format: ${tariffCode}`);
		}

		const productCode = tariffParts.slice(2, -1).join("-");
		const regionLetter = tariffParts[tariffParts.length - 1];

		console.log(
			`[${timestamp}] 🔍 Fetching product details for code: ${productCode}`
		);
		const productRes = await axios.get(
			`${octopusConfig.baseURL}/products/${productCode}/`
		);

		if (!productRes.data.single_register_electricity_tariffs) {
			throw new Error("No electricity tariffs found for product");
		}

		const tariffs = productRes.data.single_register_electricity_tariffs;
		const regionTariff = tariffs[`_${regionLetter}`];

		if (!regionTariff) {
			throw new Error(`No tariff found for region ${regionLetter}`);
		}

		// Assume direct_debit_monthly for most users
		const details = regionTariff.direct_debit_monthly;

		if (!details) {
			throw new Error("No direct debit monthly details found");
		}

		const tariffInfo = {
			name: productRes.data.display_name,
			unit_rate: (details.standard_unit_rate_inc_vat / 100).toFixed(4),
			standing_charge: (details.standing_charge_inc_vat / 100).toFixed(2),
		};

		console.log(`[${timestamp}] ✅ Tariff information received:`, tariffInfo);
		return tariffInfo;
	} catch (error) {
		console.error(
			`[${timestamp}] ❌ Error fetching tariff info:`,
			error.message
		);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
			console.error(`[${timestamp}] Request URL:`, error.config?.url);
		}
		throw error;
	}
}

// Get yesterday's usage
async function getYesterdayUsage(apiKey, mpan, serialNumber, accountNumber) {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 📅 Fetching yesterday's usage data...`);
	try {
		const yesterday = moment().subtract(1, "days").format("YYYY-MM-DD");
		const url = `${octopusConfig.baseURL}/electricity-meter-points/${mpan}/meters/${serialNumber}/consumption/`;
		console.log(`[${timestamp}] �� Requesting URL: ${url}`);

		const response = await axios.get(url, {
			headers: {
				Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
			},
			params: {
				period_from: yesterday + "T00:00:00Z",
				period_to: yesterday + "T23:59:59Z",
				page_size: 48,
			},
		});

		if (!response.data.results || response.data.results.length === 0) {
			console.log(`[${timestamp}] ℹ️ No consumption data found for yesterday`);
			return { usage: 0, cost: 0 };
		}

		const tariff = await getTariffInfo(apiKey, accountNumber, mpan);
		const totalUsage = response.data.results.reduce(
			(sum, reading) => sum + reading.consumption,
			0
		);
		const totalCost = totalUsage * parseFloat(tariff.unit_rate);
		console.log(
			`[${timestamp}] ✅ Yesterday's usage data received: ${totalUsage.toFixed(
				2
			)} kWh, £${totalCost.toFixed(2)}`
		);
		return { usage: totalUsage, cost: totalCost };
	} catch (error) {
		console.error(
			`[${timestamp}] ❌ Error fetching yesterday's usage:`,
			error.message
		);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
			console.error(`[${timestamp}] Request URL:`, error.config?.url);
		}
		return { usage: 0, cost: 0 };
	}
}

// Get monthly usage
async function getMonthlyUsage(apiKey, mpan, serialNumber, accountNumber) {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 📊 Fetching monthly usage data...`);
	try {
		const thirtyDaysAgo = moment().subtract(30, "days").format("YYYY-MM-DD");
		const url = `${octopusConfig.baseURL}/electricity-meter-points/${mpan}/meters/${serialNumber}/consumption/`;
		console.log(`[${timestamp}] 🔍 Requesting URL: ${url}`);

		const response = await axios.get(url, {
			headers: {
				Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
			},
			params: {
				period_from: thirtyDaysAgo + "T00:00:00Z",
				period_to: moment().format("YYYY-MM-DD") + "T23:59:59Z",
				page_size: 1000,
			},
		});

		if (!response.data.results || response.data.results.length === 0) {
			console.log(
				`[${timestamp}] ℹ️ No consumption data found for last 30 days`
			);
			return { usage: 0, cost: 0 };
		}

		const tariff = await getTariffInfo(apiKey, accountNumber, mpan);
		const totalUsage = response.data.results.reduce(
			(sum, reading) => sum + reading.consumption,
			0
		);
		const totalCost = totalUsage * parseFloat(tariff.unit_rate);
		console.log(
			`[${timestamp}] ✅ Monthly usage data received: ${totalUsage.toFixed(
				2
			)} kWh, £${totalCost.toFixed(2)}`
		);
		return { usage: totalUsage, cost: totalCost };
	} catch (error) {
		console.error(
			`[${timestamp}] ❌ Error fetching monthly usage:`,
			error.message
		);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
			console.error(`[${timestamp}] Request URL:`, error.config?.url);
		}
		return { usage: 0, cost: 0 };
	}
}

// API Endpoints
app.post("/api/save-credentials", (req, res) => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	const { apiKey, mpan, serialNumber, accountNumber } = req.body;
	console.log(
		`[${timestamp}] 💾 Saving credentials for account ${accountNumber}`
	);

	res.cookie(
		"octopus_credentials",
		JSON.stringify({ apiKey, mpan, serialNumber, accountNumber }),
		{
			maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
			httpOnly: true,
		}
	);
	console.log(`[${timestamp}] ✅ Credentials saved successfully`);
	res.json({ success: true });
});

app.get("/api/credentials", (req, res) => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 🔍 Checking for saved credentials`);

	const credentials = req.cookies.octopus_credentials;
	if (credentials) {
		console.log(`[${timestamp}] ✅ Found saved credentials`);
		res.json(JSON.parse(credentials));
	} else {
		console.log(`[${timestamp}] ℹ️ No saved credentials found`);
		res.json(null);
	}
});

app.get("/api/live-usage", async (req, res) => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 📊 Processing live usage request`);

	try {
		const credentials = JSON.parse(req.cookies.octopus_credentials);
		if (!credentials) {
			console.log(`[${timestamp}] ❌ No credentials found in request`);
			return res.status(401).json({ error: "No credentials found" });
		}

		if (!credentials.serialNumber) {
			console.log(`[${timestamp}] ❌ No serial number found in credentials`);
			return res.status(400).json({ error: "Meter serial number is required" });
		}

		const [liveUsage, yesterday, monthly, tariff] = await Promise.all([
			getLiveUsage(credentials.apiKey, credentials.accountNumber),
			getYesterdayUsage(
				credentials.apiKey,
				credentials.mpan,
				credentials.serialNumber,
				credentials.accountNumber
			),
			getMonthlyUsage(
				credentials.apiKey,
				credentials.mpan,
				credentials.serialNumber,
				credentials.accountNumber
			),
			getTariffInfo(
				credentials.apiKey,
				credentials.accountNumber,
				credentials.mpan
			),
		]);

		const response = {
			liveUsage,
			yesterday,
			monthly,
			tariff,
			timestamp: formatTimestamp(),
		};
		console.log(`[${timestamp}] ✅ Sending response:`, response);
		res.json(response);
	} catch (error) {
		console.error(
			`[${timestamp}] ❌ Error processing live usage request:`,
			error.message
		);
		if (error.response) {
			console.error(`[${timestamp}] Response data:`, error.response.data);
			console.error(`[${timestamp}] Response status:`, error.response.status);
		}
		res.status(500).json({ error: error.message });
	}
});

// Serve the main page
app.get("/", (req, res) => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 🌐 Serving main page`);
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	console.log(`[${timestamp}] 🚀 Server is running on port ${port}`);
	console.log(`[${timestamp}] 📝 Verbose logging enabled`);
});
