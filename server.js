require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const FormData = require('form-data');
const cloudinary = require('cloudinary').v2;
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const app = express();
const port = 3000;

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Automation state
let changeStream = null;
let isAutomationRunning = false;

app.use(express.json());
app.use(express.static(__dirname));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Button interface
app.get('/button', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Automation Control</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                }
                .container {
                    text-align: center;
                    background: white;
                    padding: 40px;
                    border-radius: 10px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                }
                h1 { color: #333; margin-bottom: 20px; }
                .status {
                    padding: 15px;
                    margin: 20px 0;
                    border-radius: 5px;
                    font-weight: bold;
                    font-size: 18px;
                }
                .status.running { background: #d4edda; color: #155724; }
                .status.stopped { background: #f8d7da; color: #721c24; }
                button {
                    padding: 15px 40px;
                    font-size: 18px;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    transition: all 0.3s;
                    margin: 10px;
                }
                .start-btn {
                    background: #28a745;
                    color: white;
                }
                .start-btn:hover { background: #218838; }
                .stop-btn {
                    background: #dc3545;
                    color: white;
                }
                .stop-btn:hover { background: #c82333; }
                button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>2nd Order Automation Control</h1>
                <div id="status" class="status">Loading...</div>
                <button id="startBtn" class="start-btn" onclick="startAutomation()">Start Listening</button>
                <button id="stopBtn" class="stop-btn" onclick="stopAutomation()">Stop Listening</button>
            </div>
            <script>
                async function updateStatus() {
                    const res = await fetch('/automation/status');
                    const data = await res.json();
                    const statusDiv = document.getElementById('status');
                    const startBtn = document.getElementById('startBtn');
                    const stopBtn = document.getElementById('stopBtn');
                    
                    if (data.running) {
                        statusDiv.textContent = 'Status: RUNNING';
                        statusDiv.className = 'status running';
                        startBtn.disabled = true;
                        stopBtn.disabled = false;
                    } else {
                        statusDiv.textContent = 'Status: STOPPED';
                        statusDiv.className = 'status stopped';
                        startBtn.disabled = false;
                        stopBtn.disabled = true;
                    }
                }
                
                async function startAutomation() {
                    await fetch('/automation/start', { method: 'POST' });
                    await updateStatus();
                }
                
                async function stopAutomation() {
                    await fetch('/automation/stop', { method: 'POST' });
                    await updateStatus();
                }
                
                updateStatus();
                setInterval(updateStatus, 2000);
            </script>
        </body>
        </html>
    `);
});

// Automation control endpoints
app.get('/automation/status', (req, res) => {
    res.json({ running: isAutomationRunning });
});

app.post('/automation/start', (req, res) => {
    if (!isAutomationRunning) {
        startChangeStream();
        res.json({ success: true, message: 'Automation started' });
    } else {
        res.json({ success: false, message: 'Automation already running' });
    }
});

app.post('/automation/stop', (req, res) => {
    if (isAutomationRunning) {
        stopChangeStream();
        res.json({ success: true, message: 'Automation stopped' });
    } else {
        res.json({ success: false, message: 'Automation already stopped' });
    }
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
        console.log('Connected to MongoDB');
        console.log('Visit http://localhost:3000/button to control automation');
    })
    .catch(err => console.error('MongoDB connection error:', err));

const orderSchema = new mongoose.Schema({
    fileName: String,
    user: mongoose.Schema.Types.ObjectId,
    paymentSource: { type: String, enum: ['regular', 'daily'] },
    userFile: {
        url: String,
        filename: String
    },
    status: { type: String, default: 'pending' },
    failureReason: String,
    adminFiles: {
        aiReport: {
            url: String
        },
        similarityReport: {
            url: String
        }
    },
    turnitin_score: String,
    turnitin_similarity: String
}, { collection: 'orders' });

const Order = mongoose.model('Order', orderSchema);

const userSchema = new mongoose.Schema({
    checks: { type: Number, default: 0 },
    unlimitedSettings: {
        dailyCreditsUsedToday: { type: Number, default: 0 }
    }
}, { collection: 'users' });

const User = mongoose.model('User', userSchema);

// Function to refund credit based on payment source
async function refundCredit(userId, paymentSource) {
    try {
        if (paymentSource === 'regular') {
            await User.findByIdAndUpdate(userId, { $inc: { checks: 1 } });
            console.log('Refunded 1 check to user:', userId);
        } else if (paymentSource === 'daily') {
            await User.findByIdAndUpdate(userId, { $inc: { 'unlimitedSettings.dailyCreditsUsedToday': -1 } });
            console.log('Refunded 1 daily credit to user:', userId);
        }
    } catch (err) {
        console.error('Failed to refund credit:', err.message);
    }
}

// Function to remove first page from PDF and upload to Cloudinary
async function processAndUploadPDF(pdfUrl, fileName) {
    const tempDir = path.join(__dirname, 'temp');
    const inputPath = path.join(tempDir, `input_${Date.now()}.pdf`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.pdf`);
    
    try {
        // Ensure temp directory exists
        await fs.mkdir(tempDir, { recursive: true });
        
        console.log('Downloading PDF from:', pdfUrl);
        // Download the PDF
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
        await fs.writeFile(inputPath, response.data);
        
        const inputSize = response.data.length;
        console.log(`Input PDF size: ${(inputSize / 1024 / 1024).toFixed(2)}MB`);
        
        // Use qpdf to remove first page (fast, preserves compression)
        console.log('Removing first page using qpdf...');
        // qpdf syntax: qpdf <in> <out> --pages <in> 2-z --
        const qpdfCommand = `qpdf "${inputPath}" "${outputPath}" --pages "${inputPath}" 2-z --`;
        
        try {
            await execAsync(qpdfCommand);
            console.log('First page removed successfully with qpdf');
            
            const outputSize = (await fs.stat(outputPath)).size;
            console.log(`Output PDF size: ${(outputSize / 1024 / 1024).toFixed(2)}MB`);
        } catch (qpdfError) {
            console.error('qpdf error:', qpdfError.message);
            throw new Error('qpdf failed to process PDF');
        }
        
        // Read the processed PDF
        const processedPdf = await fs.readFile(outputPath);
        
        // Upload to Cloudinary
        console.log('Uploading modified PDF to Cloudinary...');
        const uploadResult = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: 'raw',
                    public_id: `reports/${fileName}_${Date.now()}.pdf`,
                    folder: 'homework_reports'
                },
                (error, result) => {
                    if (error) {
                        console.error('Cloudinary upload error:', error);
                        reject(error);
                    } else {
                        console.log('Cloudinary upload successful:', result.secure_url);
                        resolve(result.secure_url);
                    }
                }
            );
            uploadStream.end(processedPdf);
        });
        
        return uploadResult;
    } catch (error) {
        console.error('Error processing PDF:', error.message);
        throw error;
    } finally {
        // Clean up temp files
        try {
            await fs.unlink(inputPath).catch(() => {});
            await fs.unlink(outputPath).catch(() => {});
        } catch (cleanupError) {
            console.error('Error cleaning up temp files:', cleanupError.message);
        }
    }
}
async function getToken() {
    try {
        const response = await axios.get('https://raw.githubusercontent.com/SanReg/automation2/main/token.txt');
        const token = response.data.trim().replace(/\r?\n/g, '');
        console.log('Token fetched successfully');
        return token;
    } catch (error) {
        console.error('Error fetching token:', error.message);
        throw error;
    }
}

// Function to get cookie from GitHub
async function getCookie() {
    try {
        const response = await axios.get('https://raw.githubusercontent.com/SanReg/automation2/main/Cookie.txt');
        const cookie = response.data.trim().replace(/\r?\n/g, '');
        console.log('Cookie fetched successfully');
        return cookie;
    } catch (error) {
        console.error('Error fetching cookie:', error.message);
        throw error;
    }
}

// Function to handle new order
async function handleNewOrder(order) {
    console.log('New order detected:', order);
    
    try {
        // Get the authorization token
        const token = await getToken();
        
        // Download the file from order.userFile.url
        const fileResponse = await axios.get(order.userFile.url, { 
            responseType: 'arraybuffer' 
        });
        
        // Prepare form data
        const fileName = order.userFile.filename || order.fileName || 'file';
        const formData = new FormData();
        formData.append('file', Buffer.from(fileResponse.data), fileName);
        
        // Post request to Supabase
        const supabaseUrl = `https://uvibhxfykplnajxopihb.supabase.co/storage/v1/object/files/d779c3f9-5c15-4e44-9e64-ed72afd12a28/${fileName}`;
        
        console.log('Posting to Supabase with token...');
        const response = await axios.post(supabaseUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'apikey': 'sb_publishable_gn-VTqpQoi1gbd7OicsF4g_LcHf0SXr',
                'Authorization': token
            }
        });
        
        console.log('Supabase response:', response.data);
        
        // Extract key from Supabase response
        const supabaseKey = response.data.Key || response.data.key || response.data.name || fileName;
        const publicFileUrl = `https://uvibhxfykplnajxopihb.supabase.co/storage/v1/object/public/${supabaseKey}`;
        
        // Get cookie for ryne.ai request
        const cookie = await getCookie();
        
        // Post request to ryne.ai/api/deep-check
        console.log('Posting to Ryne.ai deep-check API...');
        const ryneResponse = await axios.post('https://ryne.ai/api/deep-check', 
            {
                uid: 'd779c3f9-5c15-4e44-9e64-ed72afd12a28',
                fileUrl: publicFileUrl
            },
            {
                headers: {
                    'Cookie': cookie
                }
            }
        );
        
        console.log('Ryne.ai response:', ryneResponse.data);
        
        // Get history_id from ryne.ai response
        const historyId = ryneResponse.data.history_id || ryneResponse.data.historyId || ryneResponse.data.id;
        
        if (historyId) {
            console.log('Starting polling for history_id:', historyId);
            startPolling(historyId, token, order._id);
        } else {
            console.log('No history_id found in ryne.ai response');
        }
        
        return ryneResponse.data;
    } catch (error) {
        console.error('Error handling order:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
            console.error('Response status:', error.response.status);
        }
        // Mark order as failed on any error
        try {
            let reason = (error.response && error.response.data && error.response.data.error) || error.message;
            
            // Check for InvalidKey error (unicode characters in filename)
            if (error.response && error.response.data && error.response.data.error === 'InvalidKey') {
                reason = "Please make sure your filename is in full english and doesn't contain any unicode characters!";
            }
            
            if (order && order._id) {
                const updatedOrder = await Order.findByIdAndUpdate(order._id, { status: 'failed', failureReason: reason }, { new: true });
                // Refund credit to user
                if (updatedOrder && updatedOrder.user) {
                    await refundCredit(updatedOrder.user, updatedOrder.paymentSource);
                }
            }
        } catch (updateErr) {
            console.error('Failed to mark order as failed:', updateErr.message);
        }
    }
}

// Function to poll checks_history
async function startPolling(historyId, token, orderId) {
    const pollUrl = `https://uvibhxfykplnajxopihb.supabase.co/rest/v1/checks_history?id=eq.${historyId}`;
    const pollIntervalMs = 60_000; // 1 minute
    const maxWaitMs = 600_000; // 6 minutes, tweakable
    const startedAt = Date.now();
    let intervalId;

    const finalizeOrder = async (update) => {
        try {
            const updatedOrder = await Order.findByIdAndUpdate(orderId, update, { new: true });
            // Refund credit to user if order failed
            if (update.status === 'failed' && updatedOrder && updatedOrder.user) {
                await refundCredit(updatedOrder.user, updatedOrder.paymentSource);
            }
        } catch (err) {
            console.error('Failed to update order:', err.message);
        }
    };

    const poll = async () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > maxWaitMs) {
            clearInterval(intervalId);
            await finalizeOrder({ status: 'failed', failureReason: 'Failed to generate report, try again later!' });
            console.log('Polling timed out, marked order as failed');
            return;
        }

        try {
            const response = await axios.get(pollUrl, {
                headers: {
                    'apikey': 'sb_publishable_gn-VTqpQoi1gbd7OicsF4g_LcHf0SXr',
                    'Authorization': token
                }
            });
            
            console.log('Polling response:', response.data);

            const first = Array.isArray(response.data) ? response.data[0] : response.data;
            if (first && first.turnitin_status === 'done') {
                clearInterval(intervalId);
                
                try {
                    const updates = {};

                    // Store Turnitin score and similarity; use '*' when score < 20
                    if (first.turnitin_score !== undefined && first.turnitin_score !== null) {
                        const scoreNum = Number(first.turnitin_score);
                        updates.turnitin_score = (!isNaN(scoreNum) && scoreNum < 20) ? '*' : String(first.turnitin_score);
                    }

                    if (first.turnitin_similarity !== undefined && first.turnitin_similarity !== null) {
                        updates.turnitin_similarity = String(first.turnitin_similarity);
                    }

                    // Conditionally process PDFs only if URLs are present
                    if (first.turnitin_report_url) {
                        console.log('Processing AI report PDF...');
                        const aiReportUrl = await processAndUploadPDF(first.turnitin_report_url, 'ai_report');
                        updates['adminFiles.aiReport.url'] = aiReportUrl;
                    } else {
                        console.log('No AI report URL provided, skipping AI report processing');
                    }

                    if (first.turnitin_similarity_report_url) {
                        console.log('Processing similarity report PDF...');
                        const similarityReportUrl = await processAndUploadPDF(first.turnitin_similarity_report_url, 'similarity_report');
                        updates['adminFiles.similarityReport.url'] = similarityReportUrl;
                    } else {
                        console.log('No similarity report URL provided, skipping similarity report processing');
                    }

                    // Mark order completed regardless of which PDFs were available
                    updates.status = 'completed';

                    await finalizeOrder(updates);
                    console.log('Turnitin data and available PDFs processed; order updated');
                } catch (processError) {
                    console.error('Error processing PDFs or storing Turnitin data:', processError.message);
                    // If processing fails for an available PDF, mark order as failed
                    await finalizeOrder({
                        status: 'failed',
                        failureReason: 'Failed to process report PDFs'
                    });
                }
            }
        } catch (error) {
            console.error('Polling error:', error.message);
            if (error.response) {
                console.error('Polling response data:', error.response.data);
            }
        }
    };
    
    // Poll immediately and then every 1 minute
    poll();
    intervalId = setInterval(poll, pollIntervalMs);
}

// Start change stream to listen for new orders

function startChangeStream(retryCount = 0) {
    if (isAutomationRunning) {
        console.log('Change stream already running');
        return;
    }

    changeStream = Order.watch([
        { $match: { operationType: 'insert' } }
    ]);

    isAutomationRunning = true;
    console.log('Listening for new orders in the orders collection...');

    changeStream.on('change', async (change) => {
        const newOrder = change.fullDocument;
        await handleNewOrder(newOrder);
    });

    changeStream.on('error', (error) => {
        console.error('Change stream error:', error);
        isAutomationRunning = false;
        if (changeStream) {
            try { changeStream.close(); } catch (e) {}
            changeStream = null;
        }
        // Exponential backoff for reconnection
        const maxRetries = 10;
        const delay = Math.min(30000, 1000 * Math.pow(2, retryCount)); // up to 30s
        if (retryCount < maxRetries) {
            console.log(`Attempting to restart change stream in ${delay / 1000}s (retry ${retryCount + 1}/${maxRetries})...`);
            setTimeout(() => startChangeStream(retryCount + 1), delay);
        } else {
            console.error('Max retries reached. Change stream will not restart automatically.');
        }
    });
}

function stopChangeStream() {
    if (changeStream) {
        changeStream.close();
        changeStream = null;
        isAutomationRunning = false;
        console.log('Stopped listening for new orders');
    }
}

// Debug endpoint to check fetching token and cookie ✅
app.get('/test-fetch', async (req, res) => {
    try {
        const token = await getToken();
        const cookie = await getCookie();
        // Mask token/cookie for safety in logs but return full values in response for manual testing
        console.log('Fetched token (masked):', token ? token.slice(0, 8) + '...' : null);
        console.log('Fetched cookie (masked):', cookie ? cookie.slice(0, 8) + '...' : null);
        res.json({ token, cookie });
    } catch (err) {
        console.error('Test fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
