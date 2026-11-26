C     Fixed-form Fortran 77
      SUBROUTINE SCALE(N, A, FACTOR)
      INTEGER N, I
      REAL A(N), FACTOR
      DO 10 I = 1, N
         IF (A(I) .GT. 0.0 .AND. FACTOR .NE. 0.0) THEN
            A(I) = A(I) * FACTOR
         ELSE
            A(I) = 0.0
         END IF
   10 CONTINUE
      RETURN
      END

      INTEGER FUNCTION ISIGN2(X)
      REAL X
      IF (X .LT. 0.0) ISIGN2 = -1
      IF (X .GE. 0.0) ISIGN2 = 1
      RETURN
      END
