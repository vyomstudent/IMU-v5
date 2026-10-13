package org.vspimu.health

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only app-private encrypted records. Caller serializes access on its I/O executor. */
class SessionStore(context: Context) {
    private val directory = File(context.filesDir, "sessions").apply { mkdirs() }
    private val alias = "vspimu-session-key-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    private fun path(id: String): File {
        require(id.matches(Regex("[a-zA-Z0-9_-]{1,80}"))) { "Invalid record identifier" }
        return File(directory, "$id.enc")
    }

    fun save(id: String, json: String) {
        val bytes = json.toByteArray(Charsets.UTF_8)
        require(bytes.size <= 32 * 1024 * 1024) { "Session exceeds storage limit" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(bytes)
        val buffer = ByteBuffer.allocate(4 + cipher.iv.size + encrypted.size)
            .putInt(cipher.iv.size).put(cipher.iv).put(encrypted).array()
        val target = path(id)
        // AtomicFile preserves the previous ciphertext if a replacement write fails.
        val atomic = android.util.AtomicFile(target)
        var output: java.io.FileOutputStream? = null
        try {
            output = atomic.startWrite()
            output.write(buffer)
            atomic.finishWrite(output)
        } catch (e: Exception) {
            atomic.failWrite(output)
            throw e
        }
    }

    fun read(id: String): String {
        val file = path(id)
        require(file.length() in 32..(32L * 1024 * 1024 + 64)) { "Invalid encrypted record size" }
        val buffer = ByteBuffer.wrap(android.util.AtomicFile(file).readFully())
        val size = buffer.int
        require(size == 12 && buffer.remaining() > size + 16) { "Invalid encrypted record" }
        val iv = ByteArray(size).also { buffer.get(it) }
        val encrypted = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
    }

    fun ids(): List<String> = directory.listFiles().orEmpty()
        .filter { it.extension == "enc" && it.nameWithoutExtension != "active" }
        .sortedByDescending { it.lastModified() }.map { it.nameWithoutExtension }

    fun hasActive(): Boolean = path("active").exists()
    fun clearActive() { android.util.AtomicFile(path("active")).delete() }
    fun prune() { ids().drop(20).forEach { android.util.AtomicFile(path(it)).delete() } }
    fun deleteAll() {
        directory.listFiles().orEmpty().forEach { check(it.delete()) { "Could not delete a stored record" } }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }
}
