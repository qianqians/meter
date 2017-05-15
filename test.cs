/*this caller file is codegen by meter for c#*/
using System;
using System.Collections.Generic;

namespace meter
{
   public class test
   {
       public string test2;
       public int test1;
       public float test3;
       public bool test4;

       public test( string _test2, int _test1, float _test3, bool _test4 )
       {
           test2 = _test2;
           test1 = _test1;
           test3 = _test3;
           test4 = _test4;
       }
   }

   public class tests
   {
       public List<test> tables;

       public tests()
       {
           tables = new List<test>{
               new test( "123.0", 12, 1.1, false ),
               new test( "456.0", 45, 4.5, true )
           };
       }

       static private tests instance;
       static public tests GetInstance()
       {
           if (instance == null)
           {
               instance = new tests();
           }
           return instance;
       }
   }
}
