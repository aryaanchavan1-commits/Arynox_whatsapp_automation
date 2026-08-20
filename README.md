# Arynox WhatsApp Automation

A ban-resistant WhatsApp automation bot designed to mimic human behavior and reduce the risk of being banned by WhatsApp.

## Features

- Human-like typing delays based on message length
- Randomized delays between messages
- Rate limiting to prevent spamming
- Session persistence (no frequent re-login)
- Simple command handling (!help, !ping, !time)
- Easy to extend with AI responses (OpenRouter integration ready)
- QR code login via WhatsApp Web

## Anti-Ban Measures

To minimize the risk of WhatsApp banning your account:

1. **Human-like behavior**: Typing simulation and variable delays
2. **Rate limiting**: Configurable max messages per minute per user
3. **No bulk messaging**: Avoid sending identical messages to many users quickly
4. **Session persistence**: Uses local auth to avoid frequent re-login triggers
5. **Respectful usage**: Intended for personal automation, not spam marketing

## Installation

1. Clone or download this repository
2. Install Node.js (v16+)
3. Run `npm install`
4. Create a `.env` file from `.env.example` and add your OpenRouter API key (optional for AI features)
5. Run `npm start`
6. Scan the QR code with your WhatsApp phone (Linked Devices ? Link a Device)

## Configuration

Edit `.env` file:

```
OPENROUTER_API_KEY=your_openrouter_api_key_here
SESSION_NAME=arynox_session
```

Adjust anti-ban settings in `src/config.js`:
- `minDelayBetweenMessages` / `maxDelayBetweenMessages`: Random delay range between messages (ms)
- `typingDelayFactor`: Factor for typing simulation
- `maxMessagesPerMinute`: Rate limit per user

## Usage

After scanning QR code, the bot will respond to messages:
- `!help` - Show available commands
- `!ping` - Replies "Pong!"
- `!time` - Shows current time
- Any other message: Echoes back (or integrate AI)

## Extending with AI

To add AI responses using OpenRouter:
1. Get an API key from https://openrouter.ai
2. Add it to `.env` as `OPENROUTER_API_KEY`
3. Modify `src/bot.js` to call the OpenRouter API instead of echoing.

## Disclaimer

This tool is for educational purposes. WhatsApp's Terms of Service prohibit automated/unofficial clients. Use at your own risk. The author is not responsible for any bans or legal issues.

## License

ISC
