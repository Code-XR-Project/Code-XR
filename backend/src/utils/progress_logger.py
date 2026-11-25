#!/usr/bin/env python3
"""
Progress Logger Utility
Utilidad para enviar mensajes de progreso desde scripts Python a executePython.ts
"""

import sys
import json

class ProgressLogger:
    """
    Clase para enviar mensajes de progreso estructurados via stderr
    que serán capturados por executePython.ts
    """
    
    def log_info(self, message: str):
        """Envía un mensaje informativo"""
        info_data = {"info": message}
        print(json.dumps(info_data), file=sys.stderr, flush=True)
        
    def log_error(self, message: str):
        """Envía un mensaje de error"""
        error_data = {"error": message}
        print(json.dumps(error_data), file=sys.stderr, flush=True)
        
    def log_debug(self, message: str):
        """Envía un mensaje de debug"""
        debug_data = {"debug": message}
        print(json.dumps(debug_data), file=sys.stderr, flush=True)

# Instancia global para uso fácil
progress_logger = ProgressLogger()

def log_info(message: str):
    """Función de conveniencia para logging de info"""
    progress_logger.log_info(message)

def log_error(message: str):
    """Función de conveniencia para logging de error"""
    progress_logger.log_error(message)

def log_debug(message: str):
    """Función de conveniencia para logging de debug"""
    progress_logger.log_debug(message)
