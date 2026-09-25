import type { Intent } from "./agent-output";

/**
 * Emily in Spanish.
 *
 * A30: "Reply in the customer's language." Until now the bot answered a
 * Spanish speaker in English, or worse, half in each — the message that
 * started this was "Hola! Con gusto le ayudo. What are you looking to have
 * painted?", which is a greeting in one language and the question in another.
 *
 * TRANSLATED, NOT GENERATED. The model never writes an outgoing message in
 * English and it does not get to write one in Spanish either: the whole
 * safety property is that a price or an invented appointment cannot appear in
 * a message because the message comes from this table. A Spanish template is
 * the same promise in another language.
 *
 * USTED, NOT TÚ. A contractor writing to a homeowner they have never met is
 * the clearest case for the formal register there is, and it carries across
 * every market PPP serves. Mixing the two mid-thread reads worse than picking
 * the stiffer one.
 *
 * Every slot is spelled exactly as the English table spells it, because the
 * same filler code runs over both. The punctuation rules apply here too: no
 * em dashes, no ellipsis, one ask per message.
 */
export const SAYS_ES: Record<Intent, string[]> = {
  // — Recogiendo, en el orden requerido —
  ask_project_details: [
    "¿Qué le gustaría pintar?",
    "Con gusto le ayudo. ¿Cuál es el proyecto que quiere realizar?",
    "Claro que sí. ¿Qué es lo que busca pintar?",
  ],
  ask_address: [
    "¿Cuál es la dirección del proyecto?",
    "¿Dónde queda la propiedad?",
    "¿A qué dirección debe ir el estimador?",
  ],
  ask_contact: [
    "¿Cuál es el mejor nombre y correo electrónico para el estimado?",
    "¿A nombre de quién ponemos el estimado, y cuál es un buen correo?",
    "¿Me puede dar su nombre y correo electrónico para la cotización?",
  ],
  ask_availability: [
    "¿Qué días le funcionan mejor?",
    "¿Le quedan mejor los días de semana o los fines de semana?",
    "¿Qué días le vienen bien para que alguien pase a verlo?",
  ],

  // — Confirmando lo que ya tenemos —
  confirm_address: [
    "¿Es {address} la dirección correcta para el estimado?",
    "Solo para confirmar, ¿es {address} la dirección correcta del proyecto?",
  ],
  confirm_contact: [
    "¿Son {phone} y {email} la mejor manera de contactarlo sobre su cita y su cotización?",
    "¿Siguen siendo {phone} y {email} la mejor forma de comunicarnos con usted sobre el estimado?",
  ],
  confirm_scope: [
    "Solo para confirmar, usted busca: {scope}. ¿Es correcto?",
    "Entonces lo anotamos así: {scope}. ¿Está bien?",
  ],

  // — Manteniendo la conversación —
  acknowledge: ["Entendido, gracias.", "Perfecto, gracias.", "Muy bien, gracias."],
  answer_question: [""],
  acknowledge_negative: [
    "Disculpe. ¿Qué le funcionaría mejor?",
    "Una disculpa, no quise complicarle las cosas. ¿Cómo prefiere que lo hagamos?",
    "Entendido, no insisto con eso. ¿Qué preferiría usted?",
  ],

  // — A6: la cotización rápida es la RUTA, no un favor. Sin justificación. —
  present_offsite_quote: [
    "Podemos darle una cotización rápida para este proyecto. ¿Prefiere por mensaje de texto o por correo electrónico?",
    "Buenas noticias, podemos preparar una cotización rápida para este trabajo. ¿La prefiere por texto o por correo?",
  ],

  // — A7: aquí la razón es OBLIGATORIA, y es el único lugar donde lo es. —
  offer_offsite_quote: [
    "Para proyectos como este normalmente preferimos visitarlo en persona, pero como {reason}, podemos prepararle una cotización rápida. ¿Qué prefiere, eso o una cita?",
    "Un proyecto así lo solemos ver en persona, aunque como {reason}, podemos darle una cotización rápida sin la visita. ¿Cuál prefiere?",
  ],

  escalate: [
    "Permítame pasarlo con alguien de nuestro equipo. Una persona lo contactará en breve.",
    "Voy a pasar esto a nuestra oficina para que lo atiendan como se debe. Se comunicarán con usted pronto.",
  ],

  // — A33: contestar la parte que sí se puede, y SEGUIR —
  defer_to_estimator: [
    "El estimador se lo confirmará directamente. Mientras tanto, ¿qué días le funcionan mejor?",
    "Eso lo ve el estimador y lo repasará con usted. ¿Qué días le quedan bien?",
    "Nuestra oficina confirma los horarios, así que ellos se lo van a coordinar. ¿Qué días le resultan más fáciles?",
  ],

  // — Nurture: la cotización ya salió —
  nurture_check_in: [
    "¡Espero que esté muy bien! Le escribo para saber si tiene alguna pregunta sobre la cotización que le enviamos, o si ya tomó una decisión. Avísenos cuando pueda.",
    "Le escribo sobre la cotización que le enviamos. ¿Qué piensa sobre cómo le gustaría continuar?",
  ],
  ask_for_decision: [
    "¿Ha tenido oportunidad de revisarlo y tomar una decisión?",
    "¿Ya tiene alguna idea de si le gustaría seguir adelante?",
  ],
  ask_check_back: [
    "¿Cuándo sería un buen momento para volver a comunicarnos con usted?",
    "Sin ninguna prisa. ¿Cuándo le gustaría que le demos seguimiento?",
  ],
  offer_estimator_call: [
    "Puedo pedirle a su estimador que lo llame para repasar los detalles. ¿Le sirve?",
    "Con gusto le pido al estimador que lo visitó que se comunique con usted para repasarlo directamente. ¿Se lo coordino?",
  ],
  accepted: [
    "¡Qué buena noticia! Le aviso a la oficina para que lo agenden.",
    "Excelente, paso esto directo a la oficina y se comunicarán con usted para agendarlo.",
  ],

  // — Finales —
  success: [
    "Perfecto, todo listo. Alguien de la oficina le confirmará los detalles.",
    "Muy bien, eso es todo lo que necesitamos. La oficina se comunicará para confirmar.",
  ],
  phone_pricing: [
    "Los precios los repasa nuestro estimador directamente con usted, así que le pediré a alguien que lo contacte para platicarlo.",
    "No puedo dar cifras por mensaje. Eso lo maneja nuestro estimador, y le pido que lo llame.",
  ],
  schedule_follow_up: [
    "Sin ningún problema. Le doy seguimiento más adelante.",
    "Entendido. Me comunico con usted más adelante.",
  ],
  bailout: [
    "Sin problema. Lo dejo hasta aquí, y escríbanos cuando guste si algo cambia.",
    "Entendido, no lo molesto más. Aquí estamos si nos necesita.",
  ],
  transferred: [
    "Lo estoy pasando con nuestra oficina. Ellos continúan desde aquí.",
  ],
  checking_availability: [
    "Un momento, estoy revisando la disponibilidad.",
    "Deme un momento mientras reviso la disponibilidad.",
  ],
  area_not_serviced: [
    "Tengo {zip} como código postal, y lamentablemente no damos servicio en el estado de {state}. ¿El proyecto queda fuera de {state}?",
    "El código postal que tengo es {zip}, y lamentablemente no damos servicio en {state}. ¿El proyecto está en otro lugar?",
  ],
  bot_suspected: [
    "Buena pregunta. Permítame pasarlo con alguien de nuestro equipo.",
    "Pregunta justa. Le paso con una persona de nuestro equipo para que continúe.",
  ],
  discard: [
    "¡Gracias por comunicarse! Eso no es algo que nosotros hagamos. Si entendí mal el proyecto, avíseme y lo reviso de nuevo.",
    "Le agradezco que nos escriba. Lamentablemente ese no es un trabajo que hagamos. Si me equivoqué, cuénteme un poco más.",
  ],

  // Callados por diseño, igual que en inglés.
  lost: [
    "¡Entendido! Aquí estaremos si algo cambia.",
    "Entendido, gracias por avisarme. Aquí estamos si cambia de parecer.",
  ],
  msg_liked_loved: [""],
};

/** Los mismos huecos parciales que en inglés: A11 y A4. */
export const ASK_ADDRESS_GAP_ES: Record<"zip" | "street", string[]> = {
  zip: [
    "¡Gracias! ¿Cuál es el código postal de {address}?",
    "Entendido. ¿Y cuál es el código postal ahí?",
  ],
  street: [
    "¡Gracias! ¿Y cuál es la dirección de la calle?",
    "Entendido. ¿Cuál es la dirección de la calle?",
  ],
};

export const ASK_AVAILABILITY_GAP_ES: Record<"window" | "day", string[]> = {
  window: [
    "¿Qué horario le funciona esos días?",
    "¿Y más o menos a qué hora del día le queda bien?",
  ],
  day: [
    "¿Qué día le funciona mejor?",
    "¿Y qué día tenía pensado?",
  ],
};
