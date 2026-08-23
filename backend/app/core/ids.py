import secrets

# Sin 0/O ni 1/I: alguien va a teclear esto a mano desde el teclado de un celular.
# 32 símbolos * 10 caracteres = 50 bits de entropía, suficiente para que una sala
# ajena no se adivine por fuerza bruta.
_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_SLUG_LENGTH = 10


def new_room_slug() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_SLUG_LENGTH))
