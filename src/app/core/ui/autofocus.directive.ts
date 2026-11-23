import { Directive, ElementRef, inject, type AfterViewInit } from '@angular/core';

/** Enfoca (y selecciona el texto de) un input apenas se crea. */
@Directive({ selector: '[appAutofocus]' })
export class AutofocusDirective implements AfterViewInit {
  private readonly el = inject<ElementRef<HTMLInputElement>>(ElementRef);

  ngAfterViewInit(): void {
    const input = this.el.nativeElement;
    input.focus();
    input.select?.();
  }
}
