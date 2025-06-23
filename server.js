const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ChatwMe_Bot_Secure_2024_XyZ789';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // You'll get this later
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyA2GuLFnl2EM_cCwx_S_Xsx7eoB7mcuOhM';

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({ 
    dest: 'temp/',
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Webhook verification attempt:', { mode, token, challenge });

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            console.log('Webhook verification failed - wrong token');
            res.sendStatus(403);
        }
    } else {
        console.log('Webhook verification failed - missing parameters');
        res.sendStatus(400);
    }
});

// Webhook message handling endpoint
app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(function(entry) {
            const webhookEvent = entry.messaging[0];
            console.log('Received webhook event:', JSON.stringify(webhookEvent, null, 2));

            const senderId = webhookEvent.sender.id;

            if (webhookEvent.message) {
                handleMessage(senderId, webhookEvent.message);
            } else if (webhookEvent.postback) {
                handlePostback(senderId, webhookEvent.postback);
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// Handle incoming messages
async function handleMessage(senderId, message) {
    console.log(`Processing message from ${senderId}:`, message);

    // Send typing indicator
    await sendTypingIndicator(senderId, 'typing_on');

    try {
        if (message.text) {
            // Handle text messages
            await handleTextMessage(senderId, message.text);
        } else if (message.attachments) {
            // Handle attachments (images, audio, etc.)
            await handleAttachments(senderId, message.attachments);
        }
    } catch (error) {
        console.error('Error handling message:', error);
        await sendTextMessage(senderId, 'Sorry, I encountered an error processing your message. Please try again.');
    } finally {
        // Turn off typing indicator
        await sendTypingIndicator(senderId, 'typing_off');
    }
}

// Handle text messages with Gemini
async function handleTextMessage(senderId, text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `You are a helpful AI assistant chatbot on Facebook Messenger. 
        Please respond to this message in a friendly, conversational way: "${text}"
        
        Keep your response concise (under 300 characters when possible) and engaging.`;

        const result = await model.generateContent(prompt);
        const response = result.response;
        const aiResponse = response.text();

        await sendTextMessage(senderId, aiResponse);
    } catch (error) {
        console.error('Error with Gemini text generation:', error);
        await sendTextMessage(senderId, 'Sorry, I had trouble understanding that. Could you try rephrasing?');
    }
}

// Handle attachments (images, audio, etc.)
async function handleAttachments(senderId, attachments) {
    for (const attachment of attachments) {
        console.log('Processing attachment:', attachment.type);

        switch (attachment.type) {
            case 'image':
                await handleImageAttachment(senderId, attachment);
                break;
            case 'audio':
                await handleAudioAttachment(senderId, attachment);
                break;
            case 'video':
                await sendTextMessage(senderId, 'I can see you sent a video! While I can\'t process videos yet, I\'d love to help you with images or text messages. 😊');
                break;
            case 'file':
                await sendTextMessage(senderId, 'Thanks for sending a file! I work best with images and text messages right now.');
                break;
            default:
                await sendTextMessage(senderId, 'I received your message! I work best with text messages and images. How can I help you today?');
        }
    }
}

// Handle image attachments with Gemini Vision
async function handleImageAttachment(senderId, attachment) {
    try {
        console.log('Processing image attachment:', attachment.payload.url);
        
        // Download the image
        const imageResponse = await axios.get(attachment.payload.url, {
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${PAGE_ACCESS_TOKEN}`
            }
        });

        // Convert to base64
        const imageBuffer = Buffer.from(imageResponse.data);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';

        // Use Gemini Vision to analyze the image
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = "Describe what you see in this image in a friendly, conversational way. Keep it concise and engaging, as if you're chatting with a friend on messenger.";

        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: mimeType
            }
        };

        const result = await model.generateContent([prompt, imagePart]);
        const response = result.response;
        const description = response.text();

        await sendTextMessage(senderId, `I can see your image! ${description}`);

    } catch (error) {
        console.error('Error processing image:', error);
        await sendTextMessage(senderId, 'I can see you sent an image, but I had trouble analyzing it. Could you try again or describe what you\'d like to know about it?');
    }
}

// Handle audio attachments (voice messages)
async function handleAudioAttachment(senderId, attachment) {
    try {
        console.log('Processing audio attachment:', attachment.payload.url);
        
        // Note: Facebook Messenger voice messages are in different formats
        // This is a simplified approach - in production, you might want to use
        // a speech-to-text service like Google Speech-to-Text API
        
        await sendTextMessage(senderId, 'I received your voice message! 🎵 While I can\'t process audio yet, feel free to type your message and I\'ll be happy to help!');
        
        // TODO: Implement actual speech-to-text conversion
        // You could integrate with Google Speech-to-Text API, Azure Speech, or similar
        
    } catch (error) {
        console.error('Error processing audio:', error);
        await sendTextMessage(senderId, 'I had trouble with your voice message. Could you try typing your message instead?');
    }
}

// Handle postback events (button clicks, etc.)
async function handlePostback(senderId, postback) {
    console.log('Handling postback:', postback);
    
    const payload = postback.payload;
    
    switch (payload) {
        case 'GET_STARTED':
            await sendTextMessage(senderId, '👋 Hi there! I\'m your AI assistant powered by Gemini. I can help you with questions, analyze images, and have conversations. What would you like to talk about?');
            break;
        default:
            await sendTextMessage(senderId, 'Thanks for that! How can I help you today?');
    }
}

// Send text message to user
async function sendTextMessage(recipientId, messageText) {
    if (!PAGE_ACCESS_TOKEN) {
        console.error('PAGE_ACCESS_TOKEN is not set');
        return;
    }

    const messageData = {
        recipient: { id: recipientId },
        message: { text: messageText }
    };

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            messageData,
            { headers: { 'Content-Type': 'application/json' } }
        );
        
        console.log('Message sent successfully:', response.data);
    } catch (error) {
        console.error('Error sending message:', error.response?.data || error.message);
    }
}

// Send typing indicator
async function sendTypingIndicator(recipientId, action) {
    if (!PAGE_ACCESS_TOKEN) return;

    const messageData = {
        recipient: { id: recipientId },
        sender_action: action
    };

    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            messageData,
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Error sending typing indicator:', error.response?.data || error.message);
    }
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ChatwMe Bot is running!',
        timestamp: new Date().toISOString(),
        endpoints: {
            webhook_verify: 'GET /webhook',
            webhook_receive: 'POST /webhook'
        }
    });
});

// Create temp directory if it doesn't exist
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 ChatwMe Bot server is running on port ${PORT}`);
    console.log(`📝 Webhook URL will be: https://your-deployment-url.com/webhook`);
    console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
    console.log(`📱 Make sure to set your PAGE_ACCESS_TOKEN environment variable`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});