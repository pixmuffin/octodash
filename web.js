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
		const properties = accountRes.data.properties;
		const propertyWithMpan = properties.find((p) =>
			p.electricity_meter_points.some((e) => e.mpan === mpan)
		);
		if (!propertyWithMpan) {
			throw new Error(`MPAN ${mpan} not found in any property`);
		}
		const electricityPoints = propertyWithMpan.electricity_meter_points;
		const mpanPoint = electricityPoints.find((e) => e.mpan === mpan);
		const currentAgreement = mpanPoint.agreements.reduce((latest, current) => {
			if (!latest || new Date(current.valid_to) > new Date(latest.valid_to)) {
				return current;
			}
			return latest;
		}, null);
		const tariffCode = currentAgreement.tariff_code;

		const tariffParts = tariffCode.split("-");
		const productCode = tariffParts.slice(2, -1).join("-");
		const regionLetter = tariffParts[tariffParts.length - 1];

		const productRes = await axios.get(
			`${octopusConfig.baseURL}/products/${productCode}/`
		);
		const tariffs = productRes.data.single_register_electricity_tariffs;
		const regionTariff = tariffs[`_${regionLetter}`];
		const details = regionTariff.direct_debit_monthly;

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
		}
		throw error;
	}
}

// API Endpoints
app.post("/api/save-credentials", (req, res) => {
	const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
	const { apiKey, mpan, accountNumber } = req.body;
	console.log(
		`[${timestamp}] 💾 Saving credentials for account ${accountNumber}`
	);

	res.cookie(
		"octopus_credentials",
		JSON.stringify({ apiKey, mpan, accountNumber }),
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

		const liveUsage = await getLiveUsage(
			credentials.apiKey,
			credentials.accountNumber
		);
		const tariff = await getTariffInfo(
			credentials.apiKey,
			credentials.accountNumber,
			credentials.mpan
		);

		const response = {
			liveUsage,
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
