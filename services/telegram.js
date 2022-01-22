const { TelegramClient } = require('messaging-api-telegram');

const BOT_TOKEN = '2022605276:AAGSk7xOL3aEPdOxNOE-4xpNjmgscgkYXh4'
const client = new TelegramClient({
    accessToken: BOT_TOKEN,
});

class Telegram {
    constructor() {
    }

    async sendMessage(chat_id, msg) { //test-chat-id = 800863889
        return new Promise(async (resolve, reject) => {
            try {
                await client.sendMessage(chat_id, msg, {
                    disableWebPagePreview: true,
                    disableNotification: true,
                });
                resolve({ code: 200 })
            } catch (err) {
                reject(err)
            }
        })
    }
}

module.exports = () => {
    return new Telegram();
};
