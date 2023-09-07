"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MTProtoState = void 0;
const buffer_1 = require("buffer/");
const big_integer_1 = __importDefault(require("big-integer"));
const __1 = require("..");
const tl_1 = require("../tl");
const Helpers_1 = require("../Helpers");
const core_1 = require("../tl/core");
const extensions_1 = require("../extensions");
const IGE_1 = require("../crypto/IGE");
const errors_1 = require("../errors");
class MTProtoState {
    /**
     *
     `telethon.network.mtprotosender.MTProtoSender` needs to hold a state
     in order to be able to encrypt and decrypt incoming/outgoing messages,
     as well as generating the message IDs. Instances of this class hold
     together all the required information.

     It doesn't make sense to use `telethon.sessions.abstract.Session` for
     the sender because the sender should *not* be concerned about storing
     this information to disk, as one may create as many senders as they
     desire to any other data center, or some CDN. Using the same session
     for all these is not a good idea as each need their own authkey, and
     the concept of "copying" sessions with the unnecessary entities or
     updates state for these connections doesn't make sense.

     While it would be possible to have a `MTProtoPlainState` that does no
     encryption so that it was usable through the `MTProtoLayer` and thus
     avoid the need for a `MTProtoPlainSender`, the `MTProtoLayer` is more
     focused to efficiency and this state is also more advanced (since it
     supports gzipping and invoking after other message IDs). There are too
     many methods that would be needed to make it convenient to use for the
     authentication process, at which point the `MTProtoPlainSender` is better
     * @param authKey
     * @param loggers
     * @param securityChecks
     */
    constructor(authKey, loggers, securityChecks = true) {
        this.authKey = authKey;
        this._log = loggers;
        this.timeOffset = 0;
        this.salt = big_integer_1.default.zero;
        this._sequence = 0;
        this.id = this._lastMsgId = big_integer_1.default.zero;
        this.msgIds = [];
        this.securityChecks = securityChecks;
        this.reset();
    }
    /**
     * Resets the state
     */
    reset() {
        // Session IDs can be random on every connection
        this.id = __1.helpers.generateRandomLong(true);
        this._sequence = 0;
        this._lastMsgId = big_integer_1.default.zero;
        this.msgIds = [];
    }
    /**
     * Updates the message ID to a new one,
     * used when the time offset changed.
     * @param message
     */
    updateMessageId(message) {
        message.msgId = this._getNewMsgId();
    }
    /**
     * Calculate the key based on Telegram guidelines, specifying whether it's the client or not
     * @param authKey
     * @param msgKey
     * @param client
     * @returns {{iv: Buffer, key: Buffer}}
     */
    async _calcKey(authKey, msgKey, client) {
        const x = client ? 0 : 8;
        const [sha256a, sha256b] = await Promise.all([
            (0, Helpers_1.sha256)(buffer_1.Buffer.concat([msgKey, authKey.slice(x, x + 36)])),
            (0, Helpers_1.sha256)(buffer_1.Buffer.concat([authKey.slice(x + 40, x + 76), msgKey])),
        ]);
        const key = buffer_1.Buffer.concat([
            sha256a.slice(0, 8),
            sha256b.slice(8, 24),
            sha256a.slice(24, 32),
        ]);
        const iv = buffer_1.Buffer.concat([
            sha256b.slice(0, 8),
            sha256a.slice(8, 24),
            sha256b.slice(24, 32),
        ]);
        return { key, iv };
    }
    /**
     * Writes a message containing the given data into buffer.
     * Returns the message id.
     * @param buffer
     * @param data
     * @param contentRelated
     * @param afterId
     */
    async writeDataAsMessage(buffer, data, contentRelated, afterId) {
        const msgId = this._getNewMsgId();
        const seqNo = this._getSeqNo(contentRelated);
        let body;
        if (!afterId) {
            body = await core_1.GZIPPacked.gzipIfSmaller(contentRelated, data);
        }
        else {
            body = await core_1.GZIPPacked.gzipIfSmaller(contentRelated, new tl_1.Api.InvokeAfterMsg({
                msgId: afterId,
                query: {
                    getBytes() {
                        return data;
                    },
                },
            }).getBytes());
        }
        const s = buffer_1.Buffer.alloc(4);
        s.writeInt32LE(seqNo, 0);
        const b = buffer_1.Buffer.alloc(4);
        b.writeInt32LE(body.length, 0);
        const m = (0, Helpers_1.toSignedLittleBuffer)(msgId, 8);
        buffer.write(buffer_1.Buffer.concat([m, s, b]));
        buffer.write(body);
        return msgId;
    }
    /**
     * Encrypts the given message data using the current authorization key
     * following MTProto 2.0 guidelines core.telegram.org/mtproto/description.
     * @param data
     */
    async encryptMessageData(data) {
        if (!this.authKey) {
            throw new Error("Auth key unset");
        }
        await this.authKey.waitForKey();
        const authKey = this.authKey.getKey();
        if (!authKey) {
            throw new Error("Auth key unset");
        }
        if (!this.salt || !this.id || !authKey || !this.authKey.keyId) {
            throw new Error("Unset params");
        }
        const s = (0, Helpers_1.toSignedLittleBuffer)(this.salt, 8);
        const i = (0, Helpers_1.toSignedLittleBuffer)(this.id, 8);
        data = buffer_1.Buffer.concat([buffer_1.Buffer.concat([s, i]), data]);
        const padding = __1.helpers.generateRandomBytes(__1.helpers.mod(-(data.length + 12), 16) + 12);
        // Being substr(what, offset, length); x = 0 for client
        // "msg_key_large = SHA256(substr(auth_key, 88+x, 32) + pt + padding)"
        const msgKeyLarge = await (0, Helpers_1.sha256)(buffer_1.Buffer.concat([authKey.slice(88, 88 + 32), data, padding]));
        // "msg_key = substr (msg_key_large, 8, 16)"
        const msgKey = msgKeyLarge.slice(8, 24);
        const { iv, key } = await this._calcKey(authKey, msgKey, true);
        const keyId = __1.helpers.readBufferFromBigInt(this.authKey.keyId, 8);
        return buffer_1.Buffer.concat([
            keyId,
            msgKey,
            new IGE_1.IGE(key, iv).encryptIge(buffer_1.Buffer.concat([data, padding])),
        ]);
    }
    /**
     * Inverse of `encrypt_message_data` for incoming server messages.
     * @param body
     */
    async decryptMessageData(body) {
        if (!this.authKey) {
            throw new Error("Auth key unset");
        }
        if (body.length < 8) {
            throw new errors_1.InvalidBufferError(body);
        }
        // TODO Check salt,sessionId, and sequenceNumber
        const keyId = __1.helpers.readBigIntFromBuffer(body.slice(0, 8));
        if (!this.authKey.keyId || keyId.neq(this.authKey.keyId)) {
            throw new errors_1.SecurityError("Server replied with an invalid auth key");
        }
        const authKey = this.authKey.getKey();
        if (!authKey) {
            throw new errors_1.SecurityError("Unset AuthKey");
        }
        const msgKey = body.slice(8, 24);
        const { iv, key } = await this._calcKey(authKey, msgKey, false);
        body = new IGE_1.IGE(key, iv).decryptIge(body.slice(24));
        // https://core.telegram.org/mtproto/security_guidelines
        // Sections "checking sha256 hash" and "message length"
        const ourKey = await (0, Helpers_1.sha256)(buffer_1.Buffer.concat([authKey.slice(96, 96 + 32), body]));
        if (!msgKey.equals(ourKey.slice(8, 24))) {
            throw new errors_1.SecurityError("Received msg_key doesn't match with expected one");
        }
        const reader = new extensions_1.BinaryReader(body);
        reader.readLong(); // removeSalt
        const serverId = reader.readLong();
        if (serverId.neq(this.id)) {
            // throw new SecurityError('Server replied with a wrong session ID');
        }
        const remoteMsgId = reader.readLong();
        if (this.msgIds.includes(remoteMsgId.toString()) &&
            this.securityChecks) {
            throw new errors_1.SecurityError("Duplicate msgIds");
        }
        if (this.msgIds.length > 500) {
            this.msgIds.shift();
        }
        this.msgIds.push(remoteMsgId.toString());
        const remoteSequence = reader.readInt();
        reader.readInt(); // msgLen for the inner object, padding ignored
        // We could read msg_len bytes and use those in a new reader to read
        // the next TLObject without including the padding, but since the
        // reader isn't used for anything else after this, it's unnecessary.
        const obj = reader.tgReadObject();
        return new core_1.TLMessage(remoteMsgId, remoteSequence, obj);
    }
    /**
     * Generates a new unique message ID based on the current
     * time (in ms) since epoch, applying a known time offset.
     * @private
     */
    _getNewMsgId() {
        const now = new Date().getTime() / 1000 + this.timeOffset;
        const nanoseconds = Math.floor((now - Math.floor(now)) * 1e9);
        let newMsgId = (0, big_integer_1.default)(Math.floor(now))
            .shiftLeft((0, big_integer_1.default)(32))
            .or((0, big_integer_1.default)(nanoseconds).shiftLeft((0, big_integer_1.default)(2)));
        if (this._lastMsgId.greaterOrEquals(newMsgId)) {
            newMsgId = this._lastMsgId.add((0, big_integer_1.default)(4));
        }
        this._lastMsgId = newMsgId;
        return newMsgId;
    }
    /**
     * Updates the time offset to the correct
     * one given a known valid message ID.
     * @param correctMsgId {BigInteger}
     */
    updateTimeOffset(correctMsgId) {
        const bad = this._getNewMsgId();
        const old = this.timeOffset;
        const now = Math.floor(new Date().getTime() / 1000);
        const correct = correctMsgId.shiftRight((0, big_integer_1.default)(32)).toJSNumber();
        this.timeOffset = correct - now;
        if (this.timeOffset !== old) {
            this._lastMsgId = big_integer_1.default.zero;
            this._log.debug(`Updated time offset (old offset ${old}, bad ${bad}, good ${correctMsgId}, new ${this.timeOffset})`);
        }
        return this.timeOffset;
    }
    /**
     * Generates the next sequence number depending on whether
     * it should be for a content-related query or not.
     * @param contentRelated
     * @private
     */
    _getSeqNo(contentRelated) {
        if (contentRelated) {
            const result = this._sequence * 2 + 1;
            this._sequence += 1;
            return result;
        }
        else {
            return this._sequence * 2;
        }
    }
}
exports.MTProtoState = MTProtoState;
