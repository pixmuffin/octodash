# Octodash - Real-time Energy Usage Dashboard

A real-time energy usage dashboard that connects to the Octopus Energy API to display live electricity consumption, historical usage, and tariff information.

## Features

- **Live Usage Monitoring**: Real-time display of current electricity consumption in watts
- **Historical Data**: View yesterday's and last 30 days' usage and costs
- **Tariff Information**: Display current tariff details including unit rates and standing charges
- **Auto-update**: Option to automatically refresh data every 12 seconds
- **Manual Updates**: Manual refresh button with rate limiting (10-second cooldown)
- **Progress Indicator**: Visual feedback during data updates
- **Responsive Design**: Works on both desktop and mobile devices
- **Theme Support**: Light and dark mode with automatic system preference detection

## Prerequisites

- Node.js (v14 or higher)
- npm (Node Package Manager)
- An Octopus Energy account with:
  - API Key
  - MPAN (Meter Point Administration Number)
  - Meter Serial Number
  - Account Number

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/pixmuffin/octodash.git
   cd Octodash
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   node web.js
   ```

4. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Configuration

1. On first launch, you'll be prompted to enter your Octopus Energy credentials:
   - API Key
   - MPAN
   - Meter Serial Number
   - Account Number

2. These credentials are stored securely in an HTTP-only cookie and will persist for 30 days.

## Usage

### Dashboard Overview

The dashboard displays:
- Current live usage in watts
- Yesterday's total usage and cost
- Last 30 days' total usage and cost
- Current tariff information

### Controls

- **Auto-update**: Toggle to enable/disable automatic updates every 12 seconds
- **Update Now**: Manual refresh button (10-second cooldown between updates)
- **Last Updated**: Timestamp of the most recent data update

### Theme

The dashboard automatically matches your system's theme preference. You can manually toggle between light and dark mode using the theme button.

## API Integration

The application uses the following Octopus Energy API endpoints:
- GraphQL API for live usage data
- REST API for historical consumption data
- REST API for tariff information

## Security

- Credentials are stored in HTTP-only cookies
- No sensitive data is stored in local storage
- All API requests are made server-side
- Rate limiting is implemented to prevent API abuse

## Error Handling

The application includes comprehensive error handling for:
- API connection issues
- Invalid credentials
- Missing data
- Rate limiting
- Network errors

## Development

### Project Structure

```
Octodash/
├── public/
│   └── index.html    # Frontend dashboard
├── web.js           # Backend server
├── package.json     # Project dependencies
└── README.md        # This file
```

### Dependencies

- Express.js - Web server framework
- Axios - HTTP client for API requests
- Moment.js - Date/time handling
- Cookie-parser - Cookie management

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Octopus Energy for providing the API
- All contributors who have helped improve the project

## Support

If you encounter any issues or have questions, please:
1. Check the existing issues
2. Create a new issue with:
   - Detailed description of the problem
   - Steps to reproduce
   - Expected vs actual behaviour
   - Any relevant error messages
