extends Node

signal died

var health := 100

func take_damage(amount: int, critical := false) -> void:
	if amount <= 0:
		return
	var total = amount * 2 if critical else amount
	health -= total
	if health <= 0 and not is_queued_for_deletion():
		emit_signal("died")

func state_name(state: int) -> String:
	match state:
		0:
			return "idle"
		1, 2:
			return "moving"
		_:
			return "unknown"

func _process(delta):
	for child in get_children():
		while child.visible:
			child.visible = false
