//
//  LeCodesContactsPlugin.kt — lecodes-plugins/contacts
//
//  The "contacts" registerService plugin — backs the SDK `Contacts` global. A plugin and not part of
//  the SDK so that only the apps that install it carry READ_CONTACTS in their merged manifest (a
//  contacts permission is declared in Play's Data safety form). The `contacts` permission kind is
//  the host's (services/Permissions.kt): the generated glue asks it before list / get / photo / show.
//

package io.letary.lecodes.plugins.contacts

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesContactsPlugin {

    const val PLUGIN_ID = "contacts"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        ContactsChannel.register(engine) { _, events -> ContactsService(engine, appContext, events) }
    }
}
