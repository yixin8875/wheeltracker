package app.wheeltracker.securestore

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SaveArgs {
    lateinit var key: String
    lateinit var value: String
}

@InvokeArg
class KeyArgs {
    lateinit var key: String
}

/**
 * Encrypts secrets with an AES-256-GCM key held by Android Keystore. Only the
 * ciphertext and IV reach SharedPreferences, so a copied app data directory
 * cannot reveal the WebDAV password.
 */
@TauriPlugin
class SecureStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs by lazy {
        activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    @Command
    fun save(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val encrypted = cipher.doFinal(args.value.toByteArray(Charsets.UTF_8))
            val payload = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
                ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
            prefs.edit().putString(args.key, payload).apply()
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法加密保存凭据")
        }
    }

    @Command
    fun load(invoke: Invoke) {
        val args = invoke.parseArgs(KeyArgs::class.java)
        val payload = prefs.getString(args.key, null)
        val value = if (payload == null) {
            ""
        } else {
            try {
                decrypt(payload)
            } catch (error: Exception) {
                // A restored backup or a cleared Keystore leaves ciphertext we
                // can no longer read; drop it so the user can enter the
                // password again instead of retrying a dead value forever.
                prefs.edit().remove(args.key).apply()
                ""
            }
        }
        invoke.resolve(JSObject().put("value", value))
    }

    @Command
    fun delete(invoke: Invoke) {
        val args = invoke.parseArgs(KeyArgs::class.java)
        prefs.edit().remove(args.key).apply()
        invoke.resolve()
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun decrypt(payload: String): String {
        val parts = payload.split(':', limit = 2)
        require(parts.size == 2) { "已保存的凭据格式无效" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val data = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(data), Charsets.UTF_8)
    }

    companion object {
        private const val PREFS_NAME = "wheel_secure_store"
        private const val KEY_ALIAS = "wheel_webdav_credentials"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
