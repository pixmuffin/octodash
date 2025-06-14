const express = require("express");
const axios = require("axios");
const moment = require("moment");
const path = require("path");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
	port: process.env.PORT || 3000,
	cookieMaxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
	octopusBaseURL: "https://api.octopus.energy/v1",
	octopusGraphQLURL: "https://api.octopus.energy/v1/graphql/",
	encryptionAlgorithm: "aes-256-cbc",
	encryptionKey:
		process.env.COOKIE_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex"),
};

const app = express();

// =============================================================================
// LIVE USAGE HISTORY STORAGE
// =============================================================================

const LiveUsageHistory = {
	data: [], // Array to store { timestamp, usage, accountNumber }
	maxAge: 60 * 60 * 1000, // 1 hour in milliseconds

	add: function (accountNumber, usage) {
		const now = new Date();
		this.data.push({
			timestamp: now.toISOString(),
			usage: usage,
			accountNumber: accountNumber,
		});

		// Clean old data (older than 1 hour)
		this.cleanup();

		Logger.log(
			`Stored live usage data point: ${usage}W at ${now.toISOString()}`,
			"📈"
		);
	},

	cleanup: function () {
		const cutoff = new Date(Date.now() - this.maxAge);
		const originalLength = this.data.length;
		this.data = this.data.filter((point) => new Date(point.timestamp) > cutoff);

		if (this.data.length < originalLength) {
			Logger.log(
				`Cleaned ${originalLength - this.data.length} old data points`,
				"🧹"
			);
		}
	},

	getForAccount: function (accountNumber) {
		this.cleanup(); // Clean before returning
		return this.data
			.filter((point) => point.accountNumber === accountNumber)
			.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
	},
};

// =============================================================================
// LOGGING UTILITIES
// =============================================================================

const Logger = {
	timestamp: () => moment().format("YYYY-MM-DD HH:mm:ss"),

	log: (message, emoji = "ℹ️") => {
		console.log(`[${Logger.timestamp()}] ${emoji} ${message}`);
	},

	error: (message, error = null) => {
		console.error(`[${Logger.timestamp()}] ❌ ${message}`);
		if (error) {
			if (error.response) {
				console.error(
					`[${Logger.timestamp()}] Response data:`,
					error.response.data
				);
				console.error(
					`[${Logger.timestamp()}] Response status:`,
					error.response.status
				);
				console.error(
					`[${Logger.timestamp()}] Request URL:`,
					error.config?.url
				);
			} else {
				console.error(`[${Logger.timestamp()}] Error details:`, error.message);
			}
		}
	},

	success: (message) => Logger.log(message, "✅"),
	info: (message) => Logger.log(message, "ℹ️"),
	request: (method, url) => Logger.log(`${method} ${url}`, "🌐"),
};

// =============================================================================
// ENCRYPTION UTILITIES
// =============================================================================

const Encryption = {
	encrypt: (text) => {
		try {
			const key = Buffer.from(CONFIG.encryptionKey, "hex");
			const iv = crypto.randomBytes(16);
			const cipher = crypto.createCipheriv(CONFIG.encryptionAlgorithm, key, iv);

			let encrypted = cipher.update(text, "utf8", "hex");
			encrypted += cipher.final("hex");

			return iv.toString("hex") + ":" + encrypted;
		} catch (error) {
			Logger.error("Failed to encrypt data", error);
			throw new Error("Encryption failed");
		}
	},

	decrypt: (encryptedText) => {
		try {
			const key = Buffer.from(CONFIG.encryptionKey, "hex");
			const textParts = encryptedText.split(":");
			const iv = Buffer.from(textParts.shift(), "hex");
			const encrypted = textParts.join(":");

			const decipher = crypto.createDecipheriv(
				CONFIG.encryptionAlgorithm,
				key,
				iv
			);
			let decrypted = decipher.update(encrypted, "hex", "utf8");
			decrypted += decipher.final("utf8");

			return decrypted;
		} catch (error) {
			Logger.error("Failed to decrypt data", error);
			return null;
		}
	},

	encryptCookie: (data) => {
		return Encryption.encrypt(JSON.stringify(data));
	},

	decryptCookie: (encryptedData) => {
		const decryptedText = Encryption.decrypt(encryptedData);
		return decryptedText ? JSON.parse(decryptedText) : null;
	},
};

// =============================================================================
// OCTOPUS ENERGY API CLIENT
// =============================================================================

const OctopusAPI = {
	// Authentication helpers
	createAuthHeader: (apiKey) => {
		return `Basic ${Buffer.from(apiKey + ":").toString("base64")}`;
	},

	// GraphQL API methods
	getKrakenToken: async (apiKey) => {
		Logger.log("Obtaining Kraken token...", "🔑");

		try {
			const response = await axios.post(
				CONFIG.octopusGraphQLURL,
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
					headers: { "Content-Type": "application/json" },
				}
			);

			Logger.success("Kraken token obtained successfully");
			return response.data.data.obtainKrakenToken.token;
		} catch (error) {
			Logger.error("Failed to obtain Kraken token", error);
			throw error;
		}
	},

	getMeterGuid: async (token, accountNumber) => {
		Logger.log(`Looking up meter GUID for account ${accountNumber}...`, "🔍");

		try {
			const response = await axios.post(
				CONFIG.octopusGraphQLURL,
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
			if (!agreements?.length)
				throw new Error("No active electricity agreements found");

			const meters = agreements[0].meterPoint.meters;
			if (!meters?.length) throw new Error("No active meters found");

			const smartDevices = meters[0].smartDevices;
			if (!smartDevices?.length) throw new Error("No smart devices found");

			const deviceId = smartDevices[0].deviceId;
			Logger.success(`Meter GUID found: ${deviceId}`);
			return deviceId;
		} catch (error) {
			Logger.error("Failed to get meter GUID", error);
			throw error;
		}
	},

	getLiveUsage: async (apiKey, accountNumber) => {
		Logger.log("Fetching live usage data...", "📊");

		try {
			const token = await OctopusAPI.getKrakenToken(apiKey);
			const meterGuid = await OctopusAPI.getMeterGuid(token, accountNumber);

			const response = await axios.post(
				CONFIG.octopusGraphQLURL,
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

			const telemetry = response.data.data.smartMeterTelemetry;
			if (!telemetry?.length) throw new Error("No telemetry data available");

			const usage =
				telemetry[0].demand === null ? 0 : Number(telemetry[0].demand);
			Logger.success(`Live usage data received: ${usage}W`);
			return usage;
		} catch (error) {
			Logger.error("Failed to fetch live usage", error);
			return 0;
		}
	},

	// REST API methods
	getTariffInfo: async (apiKey, accountNumber, mpan) => {
		Logger.log("Fetching tariff information...", "💰");

		try {
			const authHeader = OctopusAPI.createAuthHeader(apiKey);
			const accountRes = await axios.get(
				`${CONFIG.octopusBaseURL}/accounts/${accountNumber}/`,
				{
					headers: { Authorization: authHeader },
				}
			);

			const properties = accountRes.data.properties;
			if (!properties?.length)
				throw new Error("No properties found for account");

			const propertyWithMpan = properties.find((p) =>
				p.electricity_meter_points.some((e) => e.mpan === mpan)
			);
			if (!propertyWithMpan)
				throw new Error(`MPAN ${mpan} not found in any property`);

			const mpanPoint = propertyWithMpan.electricity_meter_points.find(
				(e) => e.mpan === mpan
			);
			if (!mpanPoint?.agreements?.length)
				throw new Error("No active agreements found for MPAN");

			const currentAgreement = mpanPoint.agreements.reduce(
				(latest, current) => {
					return !latest ||
						new Date(current.valid_to) > new Date(latest.valid_to)
						? current
						: latest;
				},
				null
			);

			if (!currentAgreement) throw new Error("No valid agreement found");

			const tariffCode = currentAgreement.tariff_code;
			Logger.log(`Found tariff code: ${tariffCode}`, "📝");

			const tariffParts = tariffCode.split("-");
			if (tariffParts.length < 4)
				throw new Error(`Invalid tariff code format: ${tariffCode}`);

			const productCode = tariffParts.slice(2, -1).join("-");
			const regionLetter = tariffParts[tariffParts.length - 1];

			const productRes = await axios.get(
				`${CONFIG.octopusBaseURL}/products/${productCode}/`
			);
			const tariffs = productRes.data.single_register_electricity_tariffs;
			if (!tariffs) throw new Error("No electricity tariffs found for product");

			const regionTariff = tariffs[`_${regionLetter}`];
			if (!regionTariff?.direct_debit_monthly) {
				throw new Error(`No tariff found for region ${regionLetter}`);
			}

			const details = regionTariff.direct_debit_monthly;
			const tariffInfo = {
				name: productRes.data.display_name,
				unit_rate: (details.standard_unit_rate_inc_vat / 100).toFixed(4),
				standing_charge: (details.standing_charge_inc_vat / 100).toFixed(2),
			};

			Logger.success("Tariff information received");
			return tariffInfo;
		} catch (error) {
			Logger.error("Failed to fetch tariff info", error);
			throw error;
		}
	},

	getUsageData: async (
		apiKey,
		mpan,
		serialNumber,
		accountNumber,
		periodFrom,
		periodTo,
		logMessage,
		isMonthlyRequest = false
	) => {
		Logger.log(logMessage, "📅");
		Logger.log(`Date range: ${periodFrom} to ${periodTo}`, "📅");

		try {
			const authHeader = OctopusAPI.createAuthHeader(apiKey);
			const url = `${CONFIG.octopusBaseURL}/electricity-meter-points/${mpan}/meters/${serialNumber}/consumption/`;

			const response = await axios.get(url, {
				headers: { Authorization: authHeader },
				params: {
					period_from: periodFrom,
					period_to: periodTo,
					page_size: isMonthlyRequest ? 1500 : 48,
				},
			});

			if (!response.data.results?.length) {
				Logger.info(
					`No consumption data found for period ${periodFrom} to ${periodTo}`
				);
				return { usage: 0, cost: 0 };
			}

			const tariff = await OctopusAPI.getTariffInfo(
				apiKey,
				accountNumber,
				mpan
			);
			const totalUsage = response.data.results.reduce(
				(sum, reading) => sum + reading.consumption,
				0
			);
			const totalCost = totalUsage * parseFloat(tariff.unit_rate);

			Logger.success(
				`Usage data received for ${periodFrom} to ${periodTo}: ${totalUsage.toFixed(
					2
				)} kWh, £${totalCost.toFixed(2)} (${
					response.data.results.length
				} readings)`
			);
			return { usage: totalUsage, cost: totalCost };
		} catch (error) {
			Logger.error(
				`Failed to fetch usage data for ${periodFrom} to ${periodTo}`,
				error
			);
			return { usage: 0, cost: 0 };
		}
	},

	getYesterdayUsage: async (apiKey, mpan, serialNumber, accountNumber) => {
		const yesterday = moment().subtract(1, "days").format("YYYY-MM-DD");
		return OctopusAPI.getUsageData(
			apiKey,
			mpan,
			serialNumber,
			accountNumber,
			yesterday + "T00:00:00Z",
			yesterday + "T23:59:59Z",
			"Fetching yesterday's usage data...",
			false
		);
	},

	getMonthlyUsage: async (apiKey, mpan, serialNumber, accountNumber) => {
		const thirtyDaysAgo = moment().subtract(30, "days").format("YYYY-MM-DD");
		const today = moment().format("YYYY-MM-DD");
		return OctopusAPI.getUsageData(
			apiKey,
			mpan,
			serialNumber,
			accountNumber,
			thirtyDaysAgo + "T00:00:00Z",
			today + "T23:59:59Z",
			"Fetching monthly usage data...",
			true
		);
	},

	// Gas-related methods
	getGasTariffInfo: async (apiKey, accountNumber, mprn) => {
		Logger.log("Fetching gas tariff information...", "🔥");

		try {
			const authHeader = OctopusAPI.createAuthHeader(apiKey);
			const accountRes = await axios.get(
				`${CONFIG.octopusBaseURL}/accounts/${accountNumber}/`,
				{
					headers: { Authorization: authHeader },
				}
			);

			const properties = accountRes.data.properties;
			if (!properties?.length)
				throw new Error("No properties found for account");

			const propertyWithMprn = properties.find((p) =>
				p.gas_meter_points.some((g) => g.mprn === mprn)
			);
			if (!propertyWithMprn)
				throw new Error(`MPRN ${mprn} not found in any property`);

			const mprnPoint = propertyWithMprn.gas_meter_points.find(
				(g) => g.mprn === mprn
			);
			if (!mprnPoint?.agreements?.length)
				throw new Error("No active gas agreements found for MPRN");

			const currentAgreement = mprnPoint.agreements.reduce(
				(latest, current) => {
					return !latest ||
						new Date(current.valid_to) > new Date(latest.valid_to)
						? current
						: latest;
				},
				null
			);

			if (!currentAgreement) throw new Error("No valid gas agreement found");

			const tariffCode = currentAgreement.tariff_code;
			Logger.log(`Found gas tariff code: ${tariffCode}`, "📝");

			const tariffParts = tariffCode.split("-");
			if (tariffParts.length < 4)
				throw new Error(`Invalid gas tariff code format: ${tariffCode}`);

			const productCode = tariffParts.slice(2, -1).join("-");
			const regionLetter = tariffParts[tariffParts.length - 1];

			const productRes = await axios.get(
				`${CONFIG.octopusBaseURL}/products/${productCode}/`
			);
			const tariffs = productRes.data.single_register_gas_tariffs;
			if (!tariffs) throw new Error("No gas tariffs found for product");

			const regionTariff = tariffs[`_${regionLetter}`];
			if (!regionTariff?.direct_debit_monthly) {
				throw new Error(`No gas tariff found for region ${regionLetter}`);
			}

			const details = regionTariff.direct_debit_monthly;
			const tariffInfo = {
				name: productRes.data.display_name,
				unit_rate: (details.standard_unit_rate_inc_vat / 100).toFixed(4),
				standing_charge: (details.standing_charge_inc_vat / 100).toFixed(2),
			};

			Logger.success("Gas tariff information received");
			return tariffInfo;
		} catch (error) {
			Logger.error("Failed to fetch gas tariff info", error);
			throw error;
		}
	},

	getGasUsageData: async (
		apiKey,
		mprn,
		gasSerialNumber,
		accountNumber,
		periodFrom,
		periodTo,
		logMessage,
		isMonthlyRequest = false
	) => {
		Logger.log(logMessage, "🔥");
		Logger.log(`Gas date range: ${periodFrom} to ${periodTo}`, "🔥");

		try {
			const authHeader = OctopusAPI.createAuthHeader(apiKey);
			const url = `${CONFIG.octopusBaseURL}/gas-meter-points/${mprn}/meters/${gasSerialNumber}/consumption/`;

			const response = await axios.get(url, {
				headers: { Authorization: authHeader },
				params: {
					period_from: periodFrom,
					period_to: periodTo,
					page_size: isMonthlyRequest ? 1500 : 48,
				},
			});

			if (!response.data.results?.length) {
				Logger.info(
					`No gas consumption data found for period ${periodFrom} to ${periodTo}`
				);
				return { usage: 0, cost: 0 };
			}

			const tariff = await OctopusAPI.getGasTariffInfo(
				apiKey,
				accountNumber,
				mprn
			);
			const totalUsage = response.data.results.reduce(
				(sum, reading) => sum + reading.consumption,
				0
			);
			const totalCost = totalUsage * parseFloat(tariff.unit_rate);

			Logger.success(
				`Gas usage data received for ${periodFrom} to ${periodTo}: ${totalUsage.toFixed(
					2
				)} kWh, £${totalCost.toFixed(2)} (${
					response.data.results.length
				} readings)`
			);
			return { usage: totalUsage, cost: totalCost };
		} catch (error) {
			Logger.error(
				`Failed to fetch gas usage data for ${periodFrom} to ${periodTo}`,
				error
			);
			return { usage: 0, cost: 0 };
		}
	},

	getGasYesterdayUsage: async (
		apiKey,
		mprn,
		gasSerialNumber,
		accountNumber
	) => {
		const yesterday = moment().subtract(1, "days").format("YYYY-MM-DD");
		return OctopusAPI.getGasUsageData(
			apiKey,
			mprn,
			gasSerialNumber,
			accountNumber,
			yesterday + "T00:00:00Z",
			yesterday + "T23:59:59Z",
			"Fetching yesterday's gas usage data...",
			false
		);
	},

	getGasMonthlyUsage: async (apiKey, mprn, gasSerialNumber, accountNumber) => {
		const thirtyDaysAgo = moment().subtract(30, "days").format("YYYY-MM-DD");
		const today = moment().format("YYYY-MM-DD");
		return OctopusAPI.getGasUsageData(
			apiKey,
			mprn,
			gasSerialNumber,
			accountNumber,
			thirtyDaysAgo + "T00:00:00Z",
			today + "T23:59:59Z",
			"Fetching monthly gas usage data...",
			true
		);
	},
};

// =============================================================================
// MIDDLEWARE SETUP
// =============================================================================

// Custom logging middleware
app.use((req, res, next) => {
	Logger.request(req.method, req.url);
	next();
});

app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());

// =============================================================================
// API ROUTES
// =============================================================================

const ApiRoutes = {
	saveCredentials: async (req, res) => {
		const { apiKey, mpan, serialNumber, accountNumber, mprn, gasSerialNumber } =
			req.body;
		Logger.log(`Saving credentials for account ${accountNumber}`, "💾");

		try {
			const encryptedCredentials = Encryption.encryptCookie({
				apiKey,
				mpan,
				serialNumber,
				accountNumber,
				mprn,
				gasSerialNumber,
			});

			res.cookie("octopus_credentials", encryptedCredentials, {
				maxAge: CONFIG.cookieMaxAge,
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "strict",
			});

			Logger.success("Credentials saved successfully");
			res.json({ success: true });
		} catch (error) {
			Logger.error("Failed to save credentials", error);
			res.status(500).json({ error: "Failed to save credentials" });
		}
	},

	getCredentials: (req, res) => {
		Logger.log("Checking for saved credentials", "🔍");

		const encryptedCredentials = req.cookies.octopus_credentials;
		if (encryptedCredentials) {
			const credentials = Encryption.decryptCookie(encryptedCredentials);
			if (credentials) {
				Logger.success("Found saved credentials");
				res.json(credentials);
			} else {
				Logger.error("Failed to decrypt credentials");
				res.json(null);
			}
		} else {
			Logger.info("No saved credentials found");
			res.json(null);
		}
	},

	getLiveUsage: async (req, res) => {
		Logger.log("Processing live usage request", "📊");

		try {
			const encryptedCredentials = req.cookies.octopus_credentials;
			if (!encryptedCredentials) {
				Logger.error("No credentials found in request");
				return res.status(401).json({ error: "No credentials found" });
			}

			const credentials = Encryption.decryptCookie(encryptedCredentials);
			if (!credentials) {
				Logger.error("Failed to decrypt credentials");
				return res.status(401).json({ error: "Invalid credentials" });
			}

			if (!credentials.serialNumber) {
				Logger.error("No electricity serial number found in credentials");
				return res
					.status(400)
					.json({ error: "Electricity meter serial number is required" });
			}

			// Prepare electricity data promises
			const electricityPromises = [
				OctopusAPI.getLiveUsage(credentials.apiKey, credentials.accountNumber),
				OctopusAPI.getYesterdayUsage(
					credentials.apiKey,
					credentials.mpan,
					credentials.serialNumber,
					credentials.accountNumber
				),
				OctopusAPI.getMonthlyUsage(
					credentials.apiKey,
					credentials.mpan,
					credentials.serialNumber,
					credentials.accountNumber
				),
				OctopusAPI.getTariffInfo(
					credentials.apiKey,
					credentials.accountNumber,
					credentials.mpan
				),
			];

			// Prepare gas data promises (only if gas credentials are provided)
			let gasPromises = [];
			let hasGas = credentials.mprn && credentials.gasSerialNumber;

			if (hasGas) {
				Logger.log("Gas credentials found, fetching gas data", "🔥");
				gasPromises = [
					OctopusAPI.getGasYesterdayUsage(
						credentials.apiKey,
						credentials.mprn,
						credentials.gasSerialNumber,
						credentials.accountNumber
					),
					OctopusAPI.getGasMonthlyUsage(
						credentials.apiKey,
						credentials.mprn,
						credentials.gasSerialNumber,
						credentials.accountNumber
					),
					OctopusAPI.getGasTariffInfo(
						credentials.apiKey,
						credentials.accountNumber,
						credentials.mprn
					),
				];
			} else {
				Logger.log("No gas credentials found, skipping gas data", "ℹ️");
			}

			// Execute all promises
			const [electricityResults, gasResults] = await Promise.all([
				Promise.all(electricityPromises),
				hasGas ? Promise.all(gasPromises) : Promise.resolve([null, null, null]),
			]);

			const [
				liveUsage,
				electricityYesterday,
				electricityMonthly,
				electricityTariff,
			] = electricityResults;
			const [gasYesterday, gasMonthly, gasTariff] = gasResults;

			// Store live usage data point for historical graph
			LiveUsageHistory.add(credentials.accountNumber, liveUsage);

			// Get historical data for the graph
			const historicalData = LiveUsageHistory.getForAccount(
				credentials.accountNumber
			);

			const response = {
				electricity: {
					liveUsage,
					yesterday: electricityYesterday,
					monthly: electricityMonthly,
					tariff: electricityTariff,
					historicalData: historicalData,
				},
				gas: hasGas
					? {
							yesterday: gasYesterday,
							monthly: gasMonthly,
							tariff: gasTariff,
					  }
					: null,
				timestamp: moment().utc().format("YYYY-MM-DD HH:mm:ss UTC"),
			};

			Logger.success(
				"Sending live usage response with electricity" +
					(hasGas ? " and gas" : "") +
					" data"
			);
			res.json(response);
		} catch (error) {
			Logger.error("Failed to process live usage request", error);
			res.status(500).json({ error: error.message });
		}
	},
};

// Register API routes
app.post("/api/save-credentials", ApiRoutes.saveCredentials);
app.get("/api/credentials", ApiRoutes.getCredentials);
app.get("/api/live-usage", ApiRoutes.getLiveUsage);

// Serve the main page
app.get("/", (req, res) => {
	Logger.log("Serving main page", "🌐");
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

app.listen(CONFIG.port, () => {
	Logger.success(`Server is running on port ${CONFIG.port}`);
	Logger.log(
		`Cookie encryption ${
			process.env.COOKIE_ENCRYPTION_KEY
				? "using provided key"
				: "using auto-generated key"
		}`,
		"🔐"
	);
	Logger.log("Verbose logging enabled", "📝");
});
