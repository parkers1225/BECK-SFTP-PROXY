# Facebook Marketplace Vehicle Auto-Poster Chrome Extension

A Chrome extension that automates Facebook Marketplace vehicle listings by matching photos to vehicles via VIN, extracting vehicle data from CSV, generating AI-optimized descriptions, and auto-filling the Marketplace listing form.

## Features

- **Photo-to-VIN Matching**: Automatically matches vehicle photos to CSV data using VIN numbers extracted from filenames
- **CSV Data Integration**: Upload and parse vehicle CSV files with comprehensive vehicle information
- **AI Description Generation**: Generate optimized Facebook Marketplace descriptions using OpenAI or Anthropic Claude
- **Auto-Fill Marketplace Forms**: Automatically fills Facebook Marketplace listing forms with vehicle data
- **Clean UI**: Modern, intuitive interface for selecting vehicles and generating listings

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your Chrome toolbar

## Setup

### 1. Configure AI Service

1. Click the extension icon
2. Click the settings (⚙️) button
3. Select your AI service (OpenAI or Anthropic)
4. Enter your API key
5. Click "Save Settings"

**Getting API Keys:**
- **OpenAI**: Get your API key from https://platform.openai.com/api-keys
- **Anthropic**: Get your API key from https://console.anthropic.com/

### 2. Prepare Your CSV File

Your CSV file should contain vehicle data with the following columns:
- `vehicle_id` or `vin` - Vehicle Identification Number (17 characters)
- `make` - Vehicle make (e.g., "Jeep", "Ford")
- `model` - Vehicle model (e.g., "Wrangler", "F-150")
- `year` - Model year
- `price` or `sale_price` - Listing price
- `mileage.value` - Mileage number
- `mileage.unit` - Mileage unit (e.g., "MI")
- `exterior_color` - Vehicle color
- `image[0].url` - URL to vehicle photo
- Additional fields as needed

## Usage

### Step 1: Upload CSV
1. Open the extension popup
2. Click "Choose CSV File" and select your vehicle CSV file
3. Wait for the file to be parsed (you'll see a success message)

### Step 2: Select Vehicle Photo
- **Option A**: Click "Load Photos from CSV" to display photos from CSV URLs
- **Option B**: Click "Upload Local Photos" to upload photos from your computer
  - Photos should be named with the VIN (e.g., `1C4SJRBP7RS126541.jpg`)

### Step 3: Review Vehicle Information
- Selected vehicle information will be displayed
- Edit the price if needed
- Other fields are read-only from CSV

### Step 4: Generate AI Description
1. Enter a prompt for the AI (e.g., "Create an engaging description highlighting fuel economy and safety features")
2. Click "Generate Description"
3. Review the generated description
4. Click "Copy" to copy it, or "Regenerate" to create a new one

### Step 5: Post to Marketplace
1. Click "Open Facebook Marketplace" to navigate to the create listing page
2. Once on the page, click "Fill Marketplace Form" in the extension popup
3. The form will be auto-filled with:
   - Title (Year Make Model Trim)
   - Price
   - Description (AI-generated)
   - Category (Vehicles)
   - Location (from CSV address)
4. Review the form, upload photos manually if needed, and submit

## File Structure

```
BECK-AUTO-POST/
├── manifest.json          # Extension manifest (Manifest V3, side panel)
├── popup.html             # Extension side-panel UI
├── popup.css              # UI styling
├── popup.js               # UI logic
├── content.js             # Content script for Facebook Marketplace
├── background.js          # Service worker: AI requests via the proxy + photo fetches
├── intro.js               # Open animation (three.js), once per browser session
├── privacy-policy.html    # Privacy policy
├── lib/                   # Bundled three.js
├── fonts/                 # Bundled UI fonts
├── icons/
│   ├── beck-logo.png      # Extension icon (used for all sizes)
│   └── beck-wordmark.png  # Beck wordmark (topbar + intro)
├── server/                # SFTP proxy server (see server/README.md)
├── package.json           # Root deploy wrapper (runs the server)
├── railway.json           # Railway deployment config
└── README.md              # This file
```

## Server (SFTP Proxy)

The extension pulls vehicle CSV feeds and photos through a small Node/Express
proxy in [`server/`](server/). It connects to the dealership vAuto SFTP feeds,
caches the CSVs, and serves them over HTTP to the extension (the browser can't
talk SFTP directly). It supports multiple stores from a single deployment.

Store definitions live in `server/config.json`; **SFTP credentials are supplied
at deploy time via environment variables** (`SFTP_HOST`, `SFTP_USERNAME`,
`SFTP_PASSWORD`, or a full `STORES_CONFIG`) — never commit real credentials to
the tracked `config.json`. See [`server/README.md`](server/README.md) for setup
and deployment (Railway / Docker) details.

## Troubleshooting

### CSV Not Loading
- Ensure your CSV file has a `vehicle_id` or `vin` column
- Check that VINs are exactly 17 characters
- Verify the CSV file is properly formatted

### Photos Not Matching
- Ensure photo filenames contain the VIN (17 characters)
- VIN should be in the filename, e.g., `1C4SJRBP7RS126541.jpg`
- Check that the VIN in the filename matches a VIN in your CSV

### AI Description Not Generating
- Verify your API key is correct and has credits
- Check your internet connection
- Ensure you've entered a prompt

### Form Not Auto-Filling
- Make sure you're on the Facebook Marketplace create listing page
- The URL should contain `/marketplace/create`
- Try refreshing the page and clicking "Fill Marketplace Form" again
- Some Facebook UI changes may require updating the selectors in `content.js`

## Privacy & Security

- All data is stored locally in your browser
- API keys are stored in Chrome's secure storage
- No data is sent to third parties except the AI service you configure
- CSV files are processed locally and never uploaded to external servers

## License

This project is provided as-is for personal use.

## Support

For issues or questions, please check:
1. That all required files are present
2. That your CSV format matches the expected structure
3. That your API keys are valid
4. Browser console for error messages (F12 → Console)



