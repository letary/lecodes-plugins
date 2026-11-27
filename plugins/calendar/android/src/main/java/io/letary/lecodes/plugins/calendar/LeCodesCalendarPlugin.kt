//
//  LeCodesCalendarPlugin.kt — lecodes-plugins/calendar
//
//  The "calendar" registerService plugin — backs the SDK `Calendar` global. A plugin and not part of
//  the SDK so that only the apps that install it carry READ_CALENDAR in their merged manifest (a
//  calendar permission is declared in Play's Data safety form). The `calendar` permission kind is
//  the host's (services/Permissions.kt): the generated glue asks it before calendars / list / get / show.
//

package io.letary.lecodes.plugins.calendar

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesCalendarPlugin {

    const val PLUGIN_ID = "calendar"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        CalendarChannel.register(engine) { _, events -> CalendarService(engine, appContext, events) }
    }
}
